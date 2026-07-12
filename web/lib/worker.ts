import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { importRun, importStyleRun } from "@/lib/run-import";

// The three karaoke caption presets `shorts render --style` accepts (W11
// brief). A plain string union, not a runtime const array here -- the one
// place a style string from user input needs validating is actions/jobs.ts,
// which owns its own literal list right next to the error message it throws.
export type CaptionStyle = "s1" | "s2" | "s3";

/**
 * Worker seam. `worker` is the object other app code should call — a
 * `LocalWorker` today (spawns the Python pipeline as a subprocess), a
 * `ModalWorker` once the Modal token lands (see lib/env.ts's MODAL_TOKEN_*
 * gated vars) — same shape, different execution backend.
 */
export interface Worker {
  start(job: { id: string; source: string; outDir: string }): Promise<void>;
  /**
   * Re-renders a prior run's clips in a different caption style, reusing
   * the persisted signals/cuts already on disk at `workdir` (no
   * re-transcription/crew — `shorts render --from <workdir> --style
   * <style>`). Writes run-<style>.json + clips-<style>/ into that same
   * workdir; importStyleRun (lib/run-import.ts) picks it up on exit.
   */
  renderStyle(job: { id: string; workdir: string; style: CaptionStyle }): Promise<void>;
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
          try {
            await setJobStage(jobId, stage);
          } catch (err) {
            console.error(`[job ${jobId}] stage update failed:`, err);
          }
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
    void tailAgentEvents(jobId, outDir, () => stopped).catch((err) => {
      console.error(`[job ${jobId}] tailAgentEvents error:`, err);
    });

    child.on("exit", async (code) => {
      stopped = true;
      try {
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
      } catch (err) {
        console.error(`[job ${jobId}] exit handler error:`, err);
      }
    });

    child.on("error", async (err) => {
      stopped = true;
      try {
        await markFailed(jobId, err.message);
      } catch (dbErr) {
        console.error(`[job ${jobId}] error handler DB write failed:`, dbErr);
      }
    });

    child.unref();
  }

  // ponytail: reuses start()'s "spawn detached, stdio to a log file, import
  // on exit" shape verbatim -- just a different CLI subcommand, a per-style
  // log (so a restyle doesn't interleave with the original run's
  // worker.log), and importStyleRun instead of importRun. No tailAgentEvents
  // call: `shorts render --style` reuses persisted signals/cuts (no
  // LLM/whisper crew), so there's no agent_events.jsonl progress to tail --
  // the job just sits at whatever stage/progress reRenderStyle (the caller,
  // actions/jobs.ts) set before invoking this.
  async renderStyle(job: { id: string; workdir: string; style: CaptionStyle }): Promise<void> {
    const { id: jobId, workdir, style } = job;

    const logPath = path.join(workdir, `restyle-${style}.log`);
    const logFd = openSync(logPath, "a");

    const child = spawn(
      "uv",
      ["run", "--project", WORKER_PROJECT, "shorts", "render", "--from", workdir, "--style", style],
      { detached: true, stdio: ["ignore", logFd, logFd] },
    );
    closeSync(logFd);

    child.on("exit", async (code) => {
      try {
        const runJsonPath = path.join(workdir, `run-${style}.json`);
        try {
          await stat(runJsonPath);
          await importStyleRun(jobId, workdir, style);
        } catch {
          const tail = await stderrTail(logPath);
          await markFailed(
            jobId,
            tail || `shorts render exited with code ${code ?? "unknown"} and produced no run-${style}.json`,
          );
        }
      } catch (err) {
        console.error(`[job ${jobId}] renderStyle exit handler error:`, err);
      }
    });

    child.on("error", async (err) => {
      try {
        await markFailed(jobId, err.message);
      } catch (dbErr) {
        console.error(`[job ${jobId}] renderStyle error handler DB write failed:`, dbErr);
      }
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

  // No-op: reRenderStyle (actions/jobs.ts) already flips the job to
  // 'processing' before calling this, and StubWorker never produces a
  // run-<style>.json -- under STUB_WORKER the job simply stays
  // 'processing', same as start() leaves a job at 'processing'/'ingest'
  // rather than simulating a full run through to 'done'.
  async renderStyle(): Promise<void> {}
}

export const worker: Worker = process.env.STUB_WORKER === "1" ? new StubWorker() : new LocalWorker();
