import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentEvents, clips, jobs, users } from "@/lib/db/schema";
import { balance, debit } from "@/lib/credits";
import { importRun } from "@/lib/run-import";
import { resolveStoragePath, storage } from "@/lib/storage";
import { RunJsonSchema } from "@/lib/types";

// Matches actions/jobs.ts's flat estimate -- setup() debits this up front
// so importRun's reconcile/refund wiring has a real job_debit row to
// correct against, same as the real createJob -> worker -> importRun flow.
const ESTIMATE_MINUTES = 30;

const FIXTURE_PATH = path.join(process.cwd(), "test/fixtures/run.fixture.json");
const AGENT_EVENTS_FIXTURE_PATH = path.join(process.cwd(), "test/fixtures/agent_events.fixture.jsonl");

async function loadRealFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
}

/** Minimal valid run.json clip entry -- crafted-variant tests override fields. */
function makeClip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    candidate: { t0: 0, t1: 5, source: "fallback", notes: "", evidence: [] },
    cut: { t0: 0.1, t1: 4.9, payoff_word_i: null },
    score: { total: 10, verdict: "keep", components: {} },
    hook: { title: "Test Hook", captions: { tiktok: "cap" } },
    qa: { passed: true, failures: [] },
    repairs: [],
    dropped_reason: null,
    paths: { mp4: null, thumb: null },
    ...overrides,
  };
}

function makeRun(clipEntries: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    pipeline_version: "test",
    source: { input: "test.mp4", duration_s: 10, fps: 30, width: 100, height: 100 },
    duration_processed_s: 10,
    agent_totals: {},
    timings_s: {},
    clips: clipEntries,
    ...overrides,
  };
}

/** Creates a fresh user + job row, an outDir, and returns everything a test needs. */
async function setup() {
  const userId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `run-import-${userId}@example.com`, minutesBalance: 100 });
  await db.insert(jobs).values({ id: jobId, userId, sourceType: "url", status: "processing" });
  await debit(userId, ESTIMATE_MINUTES, jobId);
  const outDir = await mkdtemp(path.join(tmpdir(), "run-import-test-"));
  return { userId, jobId, outDir };
}

const cleanupTargets: { userId: string; jobId: string; outDir: string }[] = [];

afterEach(async () => {
  while (cleanupTargets.length > 0) {
    const { userId, jobId, outDir } = cleanupTargets.pop()!;
    await db.delete(agentEvents).where(eq(agentEvents.jobId, jobId));
    await db.delete(clips).where(eq(clips.jobId, jobId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
    await db.delete(users).where(eq(users.id, userId));
    await storage.delete(`u/${userId}/${jobId}`).catch(() => {});
    await rm(outDir, { recursive: true, force: true });
  }
});

describe("importRun: full import of the real fixture", () => {
  it("maps all 4 clips per the frozen contract's mapping rules", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const run = await loadRealFixture();
    const runClips = run.clips as { index: number; paths: { mp4: string | null; thumb: string | null } }[];

    // Real fixture's paths.mp4/thumb point at absolute paths from the
    // machine that produced it -- rewrite to small real files under outDir
    // so the storage-copy step has something to actually copy (brief's
    // documented approach: point paths at a real tmp file).
    for (const clip of runClips) {
      const mp4Path = path.join(outDir, `src_clip_${clip.index}.mp4`);
      const thumbPath = path.join(outDir, `src_clip_${clip.index}_thumb.jpg`);
      await writeFile(mp4Path, `mp4-bytes-${clip.index}`);
      await writeFile(thumbPath, `thumb-bytes-${clip.index}`);
      clip.paths.mp4 = mp4Path;
      clip.paths.thumb = thumbPath;
    }
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await importRun(jobId, outDir);

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("done");
    expect(jobRow.error).toBeNull();
    // duration_min <- duration_processed_s/60 (75.008267/60), NOT source.duration_s directly
    expect(jobRow.durationMin).toBeCloseTo(75.008267 / 60, 4);
    // agent_totals in this fixture are all cost_cents: 0.0
    expect(jobRow.costCents).toBe(0);

    const rows = await db.select().from(clips).where(eq(clips.jobId, jobId)).orderBy(asc(clips.clipIndex));
    expect(rows).toHaveLength(4);

    const [c1, c2, c3, c4] = rows;
    const fixtureClips = RunJsonSchema.parse(run).clips;

    // Clip 1: t_start/t_end <- cut.t0/t1 (NOT candidate.t0/t1, which differ
    // from cut in every clip of this fixture).
    expect(c1.tStart).toBeCloseTo(0.0, 4);
    expect(c1.tEnd).toBeCloseTo(18.94, 4);
    expect(c1.tStart).not.toBeCloseTo(fixtureClips[0].candidate.t1, 1);
    expect(c1.score).toBe(0);
    expect(c1.hook).toBe("Novelist, Essayist And Philosopher, Rona");
    expect(c1.captions).toEqual(fixtureClips[0].hook!.captions);
    expect(c1.qa).toEqual({ passed: true, failures: [] });
    expect(c1.evidence).toEqual({
      score: fixtureClips[0].score,
      candidate: fixtureClips[0].candidate,
      repairs: fixtureClips[0].repairs,
    });
    // Clip 3 has non-empty repairs (a fixed ALIGN issue) -- confirms the
    // repair history survives into the evidence blob, not just an empty array.
    expect(c3.evidence).toMatchObject({ repairs: [{ attempt: 1, codes: ["ALIGN"], route: "surgeon", outcome: "fixed" }] });
    expect(c1.status).toBe("ready");
    expect(c1.droppedReason).toBeNull();
    expect(c1.r2Key).toBe(`u/${userId}/${jobId}/clip_1.mp4`);
    expect(c1.thumbKey).toBe(`u/${userId}/${jobId}/clip_1_thumb.jpg`);
    await expect(readFile(resolveStoragePath(c1.r2Key!), "utf8")).resolves.toBe("mp4-bytes-1");
    await expect(readFile(resolveStoragePath(c1.thumbKey!), "utf8")).resolves.toBe("thumb-bytes-1");

    // Clip 2: dropped via QA's BLACK failure -- status derived from
    // dropped_reason, cut (not candidate) still used for t_start/t_end, and
    // the render is still copied (pipeline.py keeps dropped renders on disk).
    expect(c2.tStart).toBeCloseTo(19.88, 4);
    expect(c2.tEnd).toBeCloseTo(37.46, 4);
    expect(c2.status).toBe("dropped");
    expect(c2.droppedReason).toBe("BLACK");
    expect(c2.qa).toEqual({
      passed: false,
      failures: [{ code: "BLACK", detail: "1 black span(s): [Span(t0=7.741067, t1=8.241567)]" }],
    });
    expect(c2.r2Key).toBe(`u/${userId}/${jobId}/clip_2.mp4`);

    // Clips 3 & 4: ready, no drop reason.
    expect(c3.status).toBe("ready");
    expect(c3.droppedReason).toBeNull();
    expect(c4.status).toBe("ready");
    expect(c4.droppedReason).toBeNull();

    // On success, run-import reconciles the ESTIMATE_MINUTES=30 debit down
    // to actual usage (round(75.008267/60) = 1min): net charge is 1min, a
    // 29min refund landed as a job_reconcile ledger row. (setup()'s 100
    // starting balance is seeded directly, not via the ledger, so this
    // asserts against balance() only -- ledgerSum()'s cache-truth invariant
    // is covered by credits.test.ts's fully ledger-backed sequence.)
    expect(await balance(userId)).toBe(99);
  });

  it("is idempotent: re-importing the same run does not duplicate clip rows", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const run = makeRun([
      makeClip({ index: 1 }),
      makeClip({ index: 2, dropped_reason: "BLACK", score: null, hook: null, qa: null }),
    ]);
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await importRun(jobId, outDir);
    await importRun(jobId, outDir);

    const rows = await db.select().from(clips).where(eq(clips.jobId, jobId)).orderBy(asc(clips.clipIndex));
    expect(rows).toHaveLength(2);
    expect(rows[0].clipIndex).toBe(1);
    expect(rows[1].clipIndex).toBe(2);
    expect(rows[1].status).toBe("dropped");

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("done");
  });
});

describe("importRun: null-safety", () => {
  it("creates a clip row with null score/hook/qa and no source paths without crashing", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const clip = makeClip({
      index: 1,
      score: null,
      hook: null,
      qa: null,
      dropped_reason: null,
      paths: { mp4: null, thumb: null },
    });
    const run = makeRun([clip]);
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await importRun(jobId, outDir);

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("done");

    const [row] = await db.select().from(clips).where(eq(clips.jobId, jobId));
    expect(row.score).toBeNull();
    expect(row.hook).toBeNull();
    expect(row.captions).toBeNull();
    expect(row.qa).toBeNull();
    expect(row.r2Key).toBeNull();
    expect(row.thumbKey).toBeNull();
    // status derived from dropped_reason, not from score/hook/qa being null
    expect(row.status).toBe("ready");
    expect(row.evidence).toEqual({ score: null, candidate: clip.candidate, repairs: [] });
  });
});

describe("importRun: error paths", () => {
  it("marks the job failed on the worker's {error} shape, with no clip rows, without throwing", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const run = { version: 1, error: { code: "DOWNLOAD_FAILED", message: "yt-dlp exited 1" } };
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await expect(importRun(jobId, outDir)).resolves.toBeUndefined();

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("failed");
    expect(jobRow.error).toBe("yt-dlp exited 1");

    const rows = await db.select().from(clips).where(eq(clips.jobId, jobId));
    expect(rows).toHaveLength(0);

    // Auto-refund on failure (spec §7): the job never produced billable
    // output, so the full ESTIMATE_MINUTES debit from setup() comes back.
    expect(await balance(userId)).toBe(100);
  });

  it("fails loudly on a run.json version mismatch", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const run = makeRun([], { version: 2 });
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await expect(importRun(jobId, outDir)).resolves.toBeUndefined();

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("failed");
    expect(jobRow.error).toMatch(/version/i);
  });

  it("marks the job failed with zero clip rows when a clip's paths.mp4 points at a nonexistent file", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const missingPath = path.join(outDir, "does-not-exist.mp4");
    const run = makeRun([
      makeClip({ index: 1, paths: { mp4: missingPath, thumb: null } }),
    ]);
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await expect(importRun(jobId, outDir)).resolves.toBeUndefined();

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("failed");
    expect(jobRow.error).toBeTruthy();

    // Transaction never opened (copy happens before it) -- no partial/broken
    // r2_key row was ever written for this job.
    const rows = await db.select().from(clips).where(eq(clips.jobId, jobId));
    expect(rows).toHaveLength(0);
  });

  it("fails the job (not the process) on malformed JSON", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    await writeFile(path.join(outDir, "run.json"), "{not valid json");

    await expect(importRun(jobId, outDir)).resolves.toBeUndefined();

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.status).toBe("failed");
    expect(jobRow.error).toBeTruthy();
  });
});

describe("importRun: agent_events", () => {
  it("imports agent_events.jsonl rows with correct tokens", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const run = makeRun([makeClip({ index: 1 })]);
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));
    const eventsRaw = await readFile(AGENT_EVENTS_FIXTURE_PATH, "utf8");
    await writeFile(path.join(outDir, "agent_events.jsonl"), eventsRaw);

    await importRun(jobId, outDir);

    const rows = await db.select().from(agentEvents).where(eq(agentEvents.jobId, jobId));
    expect(rows).toHaveLength(3);

    const scout = rows.find((r) => r.agent === "scout");
    expect(scout).toMatchObject({ action: "propose", tokensIn: 120, tokensOut: 45 });
    expect(scout!.payload).toEqual({ clip: 0, note: "candidate window" });

    const qa = rows.find((r) => r.agent === "qa");
    expect(qa).toMatchObject({ action: "repair", tokensIn: 0, tokensOut: 0 });
  });
});

describe("importRun: cost accounting", () => {
  it("sums cost_cents across every agent in agent_totals", async () => {
    const { userId, jobId, outDir } = await setup();
    cleanupTargets.push({ userId, jobId, outDir });

    const run = makeRun([makeClip({ index: 1 })], {
      agent_totals: {
        scout: { tokens_in: 1000, tokens_out: 200, cost_cents: 12.5 },
        surgeon: { tokens_in: 500, tokens_out: 100, cost_cents: 3.5 },
      },
    });
    await writeFile(path.join(outDir, "run.json"), JSON.stringify(run));

    await importRun(jobId, outDir);

    const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow.costCents).toBe(16); // round(12.5 + 3.5)
  });
});
