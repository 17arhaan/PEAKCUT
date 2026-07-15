import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { estimatedMinutesFor, refund } from "@/lib/credits";
import { importRun, importStyleRun } from "@/lib/run-import";
import { resolveStoragePath } from "@/lib/storage";

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
  /**
   * `sourceType` distinguishes an http(s) URL source from an upload
   * storage KEY (lib/storage.ts's u/<userId>/<uploadId>/<filename>
   * convention). It's on the interface, not just a LocalWorker detail,
   * because each backend resolves an upload key differently: LocalWorker
   * turns it into an absolute filesystem path (resolveStoragePath) before
   * spawning, since the Python pipeline's ingest.resolve() treats any
   * non-URL source as a local path relative to its own cwd -- the raw
   * storage key was never a valid path there, which is why every upload
   * job used to fail with "Local file not found" while URL jobs worked
   * fine. A future ModalWorker resolves the same key its own way (e.g.
   * downloading the object from R2) using this same field. A URL source
   * passes through untouched either way.
   */
  start(job: { id: string; source: string; sourceType: "url" | "upload"; outDir: string }): Promise<void>;
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
export const AGENT_STAGE: Record<string, Stage> = {
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

export async function setJobStage(jobId: string, stage: Stage): Promise<void> {
  await db
    .update(jobs)
    .set({ stage, progress: progressForStage(stage), updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

export async function markFailed(jobId: string, error: string): Promise<void> {
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

/**
 * Turns an upload-key source into the real absolute filesystem path the
 * Python pipeline needs (Path(source) in worker/src/shorts/ingest.py's
 * resolve() -- a non-URL source is treated as a local path, and the raw
 * storage key u/<userId>/<uploadId>/file.mp4 was never one; the file
 * actually lives at web/.data/storage/u/.../file.mp4). A URL source passes
 * through untouched -- ingest.resolve()'s own _is_url check hands it to
 * yt-dlp. Exported as a pure function so a unit test can assert the
 * resolution without spawning a child process.
 */
export function resolveWorkerSource(source: string, sourceType: "url" | "upload"): string {
  return sourceType === "upload" ? resolveStoragePath(source) : source;
}

/**
 * Refunds jobId's debited estimate when the pipeline crashed before ever
 * reaching importRun -- no run.json was produced, or the child process
 * failed to spawn at all. Both paths bypass importRun entirely, so
 * importRun's own refund-on-failure branch (lib/run-import.ts) never runs
 * for them, and the sweeper (api/cron/sweep) only refunds jobs still
 * queued/processing, never one already marked 'failed' here -- without
 * this, an uncaught whisper/ffmpeg crash or spawn failure permanently
 * strands the user's debit. Reuses refund's own idempotency key
 * (reason='job_refund', ref=jobId) -- a job that reaches importRun's
 * failure path or the sweeper first (or this function running twice) is a
 * safe no-op, not a double refund. Best-effort: called from a detached
 * child process handler with nothing to propagate a rejection to, so a
 * refund failure is logged, not thrown.
 */
export async function refundOnCrash(jobId: string): Promise<void> {
  try {
    const [jobRow] = await db.select({ userId: jobs.userId }).from(jobs).where(eq(jobs.id, jobId));
    if (!jobRow) return;
    const estimate = await estimatedMinutesFor(jobRow.userId, jobId);
    if (estimate > 0) {
      await refund(jobRow.userId, jobId, estimate);
    }
  } catch (err) {
    console.error(`[job ${jobId}] refund-on-crash error:`, err);
  }
}

// One pipeline at a time on a laptop: whisper + ffmpeg saturate the machine,
// so a second simultaneous job doubles both runtimes instead of overlapping.
// ModalWorker has no such limit (each job is its own container).
// LOCAL_WORKER_CONCURRENCY overrides; read at call time so vitest can flip it
// per-test (and its setup raises it globally -- parallel test files share one
// DB, where a global processing-count gate at 1 would flake).
function maxConcurrentLocalJobs(): number {
  return Number(process.env.LOCAL_WORKER_CONCURRENCY ?? 1);
}
const QUEUE_POLL_MS = 5000;

async function countProcessingJobs(): Promise<number> {
  const rows = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "processing"));
  return rows.length;
}

export class LocalWorker implements Worker {
  async start(job: { id: string; source: string; sourceType: "url" | "upload"; outDir: string }): Promise<void> {
    // ponytail: check-then-spawn has a submit-same-instant race and the
    // in-process waiter dies with a dev-server restart (the stuck-job
    // sweeper refunds orphans) -- fine for LocalWorker's single-user dev
    // reality; a DB-locked queue if this ever fronts real traffic.
    if ((await countProcessingJobs()) >= maxConcurrentLocalJobs()) {
      // stays 'queued' (createJob's insert state); promote when a slot frees
      void this.waitForSlot(job).catch((err) => {
        console.error(`[job ${job.id}] queue waiter error:`, err);
      });
      return;
    }
    await this.launch(job);
  }

  private async waitForSlot(job: { id: string; source: string; sourceType: "url" | "upload"; outDir: string }): Promise<void> {
    for (;;) {
      await sleep(QUEUE_POLL_MS);
      // job may have been swept/deleted while queued -- stop waiting
      const [row] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.id));
      if (!row || row.status !== "queued") return;
      if ((await countProcessingJobs()) < maxConcurrentLocalJobs()) {
        await this.launch(job);
        return;
      }
    }
  }

  private async launch(job: { id: string; source: string; sourceType: "url" | "upload"; outDir: string }): Promise<void> {
    const { id: jobId, source, sourceType, outDir } = job;

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
    const resolvedSource = resolveWorkerSource(source, sourceType);
    const child = spawn(
      "uv",
      ["run", "--project", WORKER_PROJECT, "shorts", "run", resolvedSource, "-o", outDir],
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
          await refundOnCrash(jobId);
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
      await refundOnCrash(jobId);
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

// TEST-ONLY fixture paths for StubWorker.start (below). process.cwd() is
// web/ (see REPO_ROOT's comment above), matching lib/run-import.test.ts's
// own FIXTURE_PATH.
const FIXTURE_RUN_PATH = path.join(process.cwd(), "test/fixtures/run.fixture.json");
const FIXTURE_AGENT_EVENTS_PATH = path.join(process.cwd(), "test/fixtures/agent_events.fixture.jsonl");

// ponytail: fixed delay before the stub kicks off its fixture import --
// long enough that e2e specs asserting the immediate post-create
// "processing" state (new-job.spec.ts) aren't racing a near-instant import,
// short enough that happy-path.spec.ts isn't stuck waiting. Bump if that
// race ever flakes on a slower CI runner.
const STUB_IMPORT_DELAY_MS = 1500;

/**
 * TEST-ONLY: copies the committed run.fixture.json (+ agent_events fixture)
 * into a job's outDir, rewriting each clip's paths.mp4/thumb -- the real
 * fixture's are absolute paths from the machine that produced it (see
 * lib/run-import.test.ts) -- to small real files under outDir, so
 * importRun's storage-copy step has something to actually copy. Then runs
 * the REAL importer against it, same as LocalWorker's child.on("exit")
 * handler. This is what lets e2e (STUB_WORKER=1) exercise the real
 * run.json -> jobs/clips import path without spawning whisper/ffmpeg.
 * Never called outside STUB_WORKER=1.
 */
async function runStubFixture(jobId: string, outDir: string): Promise<void> {
  await sleep(STUB_IMPORT_DELAY_MS);
  await mkdir(outDir, { recursive: true });

  const raw = await readFile(FIXTURE_RUN_PATH, "utf8");
  const run = JSON.parse(raw) as {
    clips: { index: number; paths: { mp4: string | null; thumb: string | null } }[];
  };

  for (const clip of run.clips) {
    const mp4Path = path.join(outDir, `src_clip_${clip.index}.mp4`);
    const thumbPath = path.join(outDir, `src_clip_${clip.index}_thumb.jpg`);
    await writeFile(mp4Path, `stub-mp4-${clip.index}`);
    await writeFile(thumbPath, `stub-thumb-${clip.index}`);
    clip.paths.mp4 = mp4Path;
    clip.paths.thumb = thumbPath;
  }

  await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));
  await copyFile(FIXTURE_AGENT_EVENTS_PATH, path.join(outDir, "agent_events.jsonl"));

  await importRun(jobId, outDir);
}

// ponytail: ModalWorker lands with the Modal token (lib/env.ts's
// MODAL_TOKEN_ID/MODAL_TOKEN_SECRET).
//
// STUB_WORKER=1 swaps in a worker that never spawns the real uv+whisper
// subprocess. start() flips the job to processing/ingest synchronously
// (same immediate observable state as LocalWorker.start), then
// fire-and-forgets runStubFixture (above) so e2e specs can poll a job
// through to a REAL 'done' state -- real clips, scores, hooks, evidence --
// via the real importer running against fixture data, fast. Set STUB_WORKER
// for any process that must not spawn the real pipeline (playwright's dev
// server via playwright.config.ts's webServer.env). Unit tests instead mock
// this module's `worker` export directly (vi.mock("@/lib/worker", ...)) so
// createJob's own tests don't depend on this env var.
class StubWorker implements Worker {
  async start(job: { id: string; source: string; sourceType: "url" | "upload"; outDir: string }): Promise<void> {
    await db
      .update(jobs)
      .set({ status: "processing", stage: "ingest", progress: 0, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));

    void runStubFixture(job.id, job.outDir).catch((err) => {
      console.error(`[job ${job.id}] stub fixture import error:`, err);
    });
  }

  // No-op: reRenderStyle (actions/jobs.ts) already flips the job to
  // 'processing' before calling this, and StubWorker never produces a
  // run-<style>.json -- under STUB_WORKER a restyle simply stays
  // 'processing' forever (e2e/caption-style.spec.ts only asserts the
  // optimistic in-flight state, never a completed restyle).
  async renderStyle(): Promise<void> {}
}

/**
 * Dispatches jobs to the deployed Modal pipeline (modal_app.py's `trigger`
 * fastapi_endpoint) instead of spawning a local subprocess. The remote
 * worker uploads finished clips straight to R2 under the conventional keys
 * and POSTs progress + completion back to /api/worker/callback (which runs
 * importRun with `preuploaded: true`). Auth both ways is WORKER_SHARED_SECRET.
 */
export class ModalWorker implements Worker {
  constructor(
    private readonly cfg: { triggerUrl: string; secret: string; appUrl: string },
  ) {}

  async start(job: { id: string; source: string; sourceType: "url" | "upload"; outDir: string }): Promise<void> {
    const { id: jobId, source, sourceType } = job;
    const [jobRow] = await db.select({ userId: jobs.userId }).from(jobs).where(eq(jobs.id, jobId));
    if (!jobRow) throw new Error(`job ${jobId} not found`);

    await db
      .update(jobs)
      .set({ status: "processing", stage: "ingest", progress: 0, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));

    try {
      const res = await fetch(this.cfg.triggerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.secret}`,
        },
        body: JSON.stringify({
          job_id: jobId,
          user_id: jobRow.userId,
          source,
          source_type: sourceType,
          callback_url: `${this.cfg.appUrl.replace(/\/$/, "")}/api/worker/callback`,
        }),
      });
      if (!res.ok) {
        throw new Error(`Modal trigger responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    } catch (err) {
      await markFailed(jobId, err instanceof Error ? err.message : String(err));
      await refundOnCrash(jobId);
    }
  }

  // ponytail: restyle needs the run's workdir, which lives on the Modal
  // Volume, not here -- wire a second endpoint against that Volume when
  // restyle-on-Modal matters. The action surfaces this message to the UI.
  async renderStyle(): Promise<void> {
    throw new Error("Caption restyle isn't available on cloud processing yet.");
  }
}

function selectWorker(): Worker {
  if (process.env.STUB_WORKER === "1") return new StubWorker();
  const { MODAL_TRIGGER_URL, WORKER_SHARED_SECRET, APP_URL } = env;
  if (MODAL_TRIGGER_URL && WORKER_SHARED_SECRET && APP_URL) {
    return new ModalWorker({
      triggerUrl: MODAL_TRIGGER_URL,
      secret: WORKER_SHARED_SECRET,
      appUrl: APP_URL,
    });
  }
  return new LocalWorker();
}

export const worker: Worker = selectWorker();
