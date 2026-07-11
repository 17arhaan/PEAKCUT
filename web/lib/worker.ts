import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/**
 * Worker seam. `worker` is the object other app code should call — a
 * `LocalWorker` today (spawns the Python pipeline as a subprocess), a
 * `ModalWorker` once the Modal token lands (see lib/env.ts's MODAL_TOKEN_*
 * gated vars) — same shape, different execution backend.
 */
export interface Worker {
  start(job: { id: string; source: string; outDir: string }): Promise<void>;
}

// repoRoot/worker is the Python pipeline. Next always runs with cwd = this
// project's root (web/) in dev, build, and start — same assumption
// lib/storage.ts's STORAGE_ROOT makes — so repoRoot is one level up.
const REPO_ROOT = path.resolve(process.cwd(), "..");
const WORKER_PROJECT = path.join(REPO_ROOT, "worker");

// Cumulative stage weights for jobs.progress (0..1). Survivor clip count
// isn't known until the crew stage finishes scoring candidates, so progress
// is stage-based (how far through the pipeline) rather than clip-count-based.
export const STAGE_WEIGHTS = {
  ingest: 0.1,
  signals: 0.3,
  crew: 0.3,
  render: 0.3,
} as const;

export type Stage = keyof typeof STAGE_WEIGHTS;

const STAGE_ORDER: Stage[] = ["ingest", "signals", "crew", "render"];

// worker/src/shorts/agent_log.py's `agent` field -> which pipeline stage
// that event belongs to (see worker/src/shorts/agents/*.py's log.emit call
// sites: scout/critic/orchestrator run inside orchestrator.run_crew, i.e.
// the crew stage; surgeon/hooks/qa run inside the cuts+render+qa+repair
// stage, i.e. render). "ingest"/"signals" aren't emitted as agent names
// today (those stages don't call AgentLog) but are mapped defensively in
// case that changes.
const AGENT_STAGE: Record<string, Stage> = {
  ingest: "ingest",
  signals: "signals",
  scout: "crew",
  critic: "crew",
  orchestrator: "crew",
  surgeon: "render",
  hooks: "render",
  qa: "render",
  render: "render",
};

function progressForStage(stage: Stage): number {
  let sum = 0;
  for (const s of STAGE_ORDER) {
    sum += STAGE_WEIGHTS[s];
    if (s === stage) break;
  }
  return sum;
}

async function setJobStage(jobId: string, stage: Stage): Promise<void> {
  await db
    .update(jobs)
    .set({ stage, progress: progressForStage(stage), updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

async function markFailed(jobId: string, error: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "failed", error: error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

// W7 implements this: parses outDir/run.json (+ per-clip artifacts) into
// `clips` rows and marks the job `done` with duration/cost derived from the
// run. Stubbed here so the worker seam has somewhere to hand off on a
// successful exit; this stub just flips the job to done so the create ->
// spawn -> complete flow is demonstrably whole end to end.
export async function importRun(jobId: string, _outDir: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", stage: "render", progress: 1, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

const POLL_MS = 1000;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tails outDir/agent_events.jsonl (created partway through the run, once
 * ingest/signals hand off to the crew) and advances jobs.stage/progress as
 * new agent names appear. Runs independently of the server action that
 * kicked off `start()` — that action has already returned by the time this
 * loop does anything. Stops when `stopped()` returns true (set by the
 * child's exit/error handler).
 */
async function tailAgentEvents(jobId: string, outDir: string, stopped: () => boolean) {
  const filePath = path.join(outDir, "agent_events.jsonl");
  let offset = 0;
  let stageIdx = -1;

  while (!stopped()) {
    await sleep(POLL_MS);

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      continue; // not created yet
    }
    if (size <= offset) continue;

    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = size;

      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        let record: { agent?: unknown };
        try {
          record = JSON.parse(line);
        } catch {
          continue; // partial line at the tail end of a growing file
        }
        const agent = typeof record.agent === "string" ? record.agent : undefined;
        const stage = agent ? AGENT_STAGE[agent] : undefined;
        if (!stage) continue;

        const idx = STAGE_ORDER.indexOf(stage);
        if (idx > stageIdx) {
          stageIdx = idx;
          await setJobStage(jobId, stage);
        }
      }
    } finally {
      await fh.close();
    }
  }
}

async function stderrTail(logPath: string): Promise<string> {
  try {
    const content = await readFile(logPath, "utf8");
    return content.slice(-2000);
  } catch {
    return "";
  }
}

export class LocalWorker implements Worker {
  async start(job: { id: string; source: string; outDir: string }): Promise<void> {
    const { id: jobId, source, outDir } = job;

    await mkdir(outDir, { recursive: true });
    await db
      .update(jobs)
      .set({ status: "processing", stage: "ingest", progress: 0, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));

    const logPath = path.join(outDir, "worker.log");
    const logFd = openSync(logPath, "a");

    // Detached + unref'd so the server action's spawn() call returns
    // immediately and the child survives this Next.js process restarting.
    // stdio goes to a log file, not `inherit` — this process's own
    // stdout/stderr isn't the right place for a job's pipeline output.
    const child = spawn(
      "uv",
      ["run", "--project", WORKER_PROJECT, "shorts", "run", source, "-o", outDir],
      { detached: true, stdio: ["ignore", logFd, logFd] },
    );
    closeSync(logFd); // child has its own dup of the fd; safe to close ours

    let stopped = false;
    void tailAgentEvents(jobId, outDir, () => stopped);

    child.on("exit", async (code) => {
      stopped = true;
      const runJsonPath = path.join(outDir, "run.json");
      try {
        await stat(runJsonPath);
        await importRun(jobId, outDir);
      } catch {
        const tail = await stderrTail(logPath);
        await markFailed(
          jobId,
          tail || `pipeline exited with code ${code ?? "unknown"} and produced no run.json`,
        );
      }
    });

    child.on("error", async (err) => {
      stopped = true;
      await markFailed(jobId, err.message);
    });

    child.unref();
  }
}

// ponytail: ModalWorker lands with the Modal token (lib/env.ts's
// MODAL_TOKEN_ID/MODAL_TOKEN_SECRET).
//
// STUB_WORKER=1 swaps in a no-op worker that only does the DB status flip —
// no subprocess. Set it for any process that must not spawn the real
// uv+whisper pipeline (playwright's dev server via playwright.config.ts's
// webServer.env). Unit tests instead mock this module's `worker` export
// directly (vi.mock("@/lib/worker", ...)) so createJob's own tests don't
// depend on this env var.
class StubWorker implements Worker {
  async start(job: { id: string; source: string; outDir: string }): Promise<void> {
    await db
      .update(jobs)
      .set({ status: "processing", stage: "ingest", progress: 0, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
  }
}

export const worker: Worker = process.env.STUB_WORKER === "1" ? new StubWorker() : new LocalWorker();
