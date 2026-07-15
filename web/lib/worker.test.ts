import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked so start()'s spawn is observable (args asserted) and no real uv/
// whisper subprocess ever runs -- these are unit tests of the worker seam,
// not an integration test of the Python pipeline.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { db } from "@/lib/db";
import { creditLedger, jobs, users } from "@/lib/db/schema";
import { balance, debit, refund } from "@/lib/credits";
import { resolveStoragePath } from "@/lib/storage";
import { LocalWorker, resolveWorkerSource } from "./worker";

type Handler = (...args: unknown[]) => unknown;

/** A fake child_process handle: records event listeners so a test can fire
 * "exit"/"error" directly (awaiting the async handler) instead of racing a
 * real EventEmitter's synchronous emit against an async handler body. */
function makeFakeChild() {
  const handlers: Record<string, Handler> = {};
  return {
    child: {
      on(event: string, cb: Handler) {
        handlers[event] = cb;
        return this;
      },
      unref() {},
    },
    async trigger(event: string, ...args: unknown[]) {
      await handlers[event]?.(...args);
    },
  };
}

describe("resolveWorkerSource", () => {
  it("resolves an upload key to its real absolute storage path", () => {
    const key = "u/user1/upload1/source.mp4";
    expect(resolveWorkerSource(key, "upload")).toBe(resolveStoragePath(key));
  });

  it("leaves an http(s) URL unchanged", () => {
    const url = "https://youtube.com/watch?v=dQw4w9WgXcQ";
    expect(resolveWorkerSource(url, "url")).toBe(url);
  });
});

describe("LocalWorker.start spawn args", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "worker-test-"));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild().child);
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("spawns with the resolved absolute path for an upload job, not the raw storage key", async () => {
    const worker = new LocalWorker();
    const key = "u/user1/upload1/source.mp4";

    await worker.start({ id: crypto.randomUUID(), source: key, sourceType: "upload", outDir });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain(resolveStoragePath(key));
    expect(args).not.toContain(key);
  });

  it("spawns with the raw URL unchanged for a URL job", async () => {
    const worker = new LocalWorker();
    const url = "https://youtube.com/watch?v=dQw4w9WgXcQ";

    await worker.start({ id: crypto.randomUUID(), source: url, sourceType: "url", outDir });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain(url);
  });
});

describe("LocalWorker crash-path refund (no run.json / spawn error)", () => {
  const ESTIMATE_MINUTES = 30;
  let outDir: string;
  let userId: string;
  let jobId: string;
  let currentFake: ReturnType<typeof makeFakeChild>;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "worker-crash-test-"));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      currentFake = makeFakeChild();
      return currentFake.child;
    });

    userId = crypto.randomUUID();
    jobId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: `worker-crash-${userId}@example.com`, minutesBalance: 100 });
    await db.insert(jobs).values({
      id: jobId,
      userId,
      sourceType: "url",
      sourceUrl: "https://youtube.com/watch?v=x",
      status: "queued",
    });
    // Mirrors createJob's pre-worker.start debit -- start() itself never debits.
    await debit(userId, ESTIMATE_MINUTES, jobId);
  });

  afterEach(async () => {
    await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
    await db.delete(users).where(eq(users.id, userId));
    await rm(outDir, { recursive: true, force: true });
  });

  it("refunds the debited estimate when the child exits with no run.json produced", async () => {
    const balanceAfterDebit = await balance(userId);
    const worker = new LocalWorker();
    await worker.start({ id: jobId, source: "https://youtube.com/watch?v=x", sourceType: "url", outDir });

    // No run.json ever written to outDir -- simulates whisper/ffmpeg dying
    // mid-run without producing output.
    await currentFake.trigger("exit", 1);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("failed");

    expect(await balance(userId)).toBe(balanceAfterDebit + ESTIMATE_MINUTES);
    const refundRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, "job_refund"), eq(creditLedger.ref, jobId)));
    expect(refundRows).toHaveLength(1);
  });

  it("is idempotent: a concurrent/duplicate refund for the same job doesn't double-refund", async () => {
    const worker = new LocalWorker();
    await worker.start({ id: jobId, source: "https://youtube.com/watch?v=x", sourceType: "url", outDir });
    await currentFake.trigger("exit", 1);

    const balanceAfterFirstRefund = await balance(userId);

    // Same (reason='job_refund', ref=jobId) key refundOnCrash uses --
    // stands in for importRun's own refund-on-failure path (or a second
    // crash-handler invocation) racing the same job.
    await refund(userId, jobId, ESTIMATE_MINUTES);

    expect(await balance(userId)).toBe(balanceAfterFirstRefund);
    const refundRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, "job_refund"), eq(creditLedger.ref, jobId)));
    expect(refundRows).toHaveLength(1);
  });

  it("refunds the debited estimate when the child fails to spawn", async () => {
    const balanceAfterDebit = await balance(userId);
    const worker = new LocalWorker();
    await worker.start({ id: jobId, source: "https://youtube.com/watch?v=x", sourceType: "url", outDir });

    await currentFake.trigger("error", new Error("spawn uv ENOENT"));

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("spawn uv ENOENT");
    expect(await balance(userId)).toBe(balanceAfterDebit + ESTIMATE_MINUTES);
  });
});

describe("LocalWorker concurrency gate", () => {
  let outDir: string;
  let userId: string;
  let processingJobId: string;
  let queuedJobId: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "worker-gate-test-"));
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild().child);

    userId = crypto.randomUUID();
    processingJobId = crypto.randomUUID();
    queuedJobId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: `worker-gate-${userId}@example.com`, minutesBalance: 100 });
    await db.insert(jobs).values([
      {
        id: processingJobId,
        userId,
        sourceType: "url",
        sourceUrl: "https://youtube.com/watch?v=busy",
        status: "processing",
      },
      {
        id: queuedJobId,
        userId,
        sourceType: "url",
        sourceUrl: "https://youtube.com/watch?v=waiting",
        status: "queued",
      },
    ]);
  });

  afterEach(async () => {
    // delete rows FIRST so the background slot-waiter (5s poll) sees the job
    // gone and exits instead of spawning after the test ends
    await db.delete(jobs).where(eq(jobs.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await rm(outDir, { recursive: true, force: true });
    process.env.LOCAL_WORKER_CONCURRENCY = "1000";
  });

  it("holds a second job at 'queued' (no spawn) while another is processing", async () => {
    process.env.LOCAL_WORKER_CONCURRENCY = "1";
    const worker = new LocalWorker();

    await worker.start({
      id: queuedJobId,
      source: "https://youtube.com/watch?v=waiting",
      sourceType: "url",
      outDir,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    const [row] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, queuedJobId));
    expect(row.status).toBe("queued");
  });
});
