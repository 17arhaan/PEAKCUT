import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
// createJob's own tests mock the worker singleton directly (not
// STUB_WORKER=1) so they cover the actual "did createJob call worker.start
// with the right job" contract, not just "did createJob avoid spawning".
// reRenderStyle's tests below mock worker.renderStyle the same way.
vi.mock("@/lib/worker", () => ({
  worker: { start: vi.fn().mockResolvedValue(undefined), renderStyle: vi.fn().mockResolvedValue(undefined) },
}));

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { creditLedger, jobs, users } from "@/lib/db/schema";
import { worker } from "@/lib/worker";
import { balance } from "@/lib/credits";
import { createJob, reRenderStyle } from "./jobs";

const mockAuth = vi.mocked(auth);
const mockWorkerStart = vi.mocked(worker.start);
const mockWorkerRenderStyle = vi.mocked(worker.renderStyle);

describe("createJob", () => {
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

  beforeAll(async () => {
    // W9: createJob now debits real minutes (ESTIMATE_MINUTES) before
    // starting the worker -- seed enough balance for every debit these
    // tests make across the whole describe block.
    await db.insert(users).values([
      { id: userId, email: `jobs-test-${userId}@example.com`, minutesBalance: 1000 },
      { id: otherUserId, email: `jobs-test-${otherUserId}@example.com`, minutesBalance: 1000 },
    ]);
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  beforeEach(() => {
    mockAuth.mockReset();
    mockWorkerStart.mockReset().mockResolvedValue(undefined);
    mockWorkerRenderStyle.mockReset().mockResolvedValue(undefined);
  });

  it("inserts a queued job row and starts the worker for a valid URL", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    const { jobId } = await createJob({
      source: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      sourceType: "url",
    });

    expect(jobId).toBeTruthy();

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row).toMatchObject({
      id: jobId,
      userId,
      sourceType: "url",
      sourceUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      r2Key: null,
      status: "queued",
    });

    expect(mockWorkerStart).toHaveBeenCalledTimes(1);
    const call = mockWorkerStart.mock.calls[0][0];
    expect(call.id).toBe(jobId);
    expect(call.source).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(call.outDir).toContain(jobId);
  });

  it("inserts a queued job row for an owned upload key", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    const key = `u/${userId}/upload1/source.mp4`;
    const { jobId } = await createJob({ source: key, sourceType: "upload" });

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row).toMatchObject({
      sourceType: "upload",
      sourceUrl: null,
      r2Key: key,
    });
    expect(mockWorkerStart).toHaveBeenCalledTimes(1);
  });

  it("rejects when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(
      createJob({ source: "https://youtube.com/watch?v=x", sourceType: "url" }),
    ).rejects.toThrow(/unauthorized/i);

    expect(mockWorkerStart).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) URL", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    await expect(createJob({ source: "not-a-url", sourceType: "url" })).rejects.toThrow();
    await expect(
      createJob({ source: "javascript:alert(1)", sourceType: "url" }),
    ).rejects.toThrow();
    await expect(createJob({ source: "ftp://host/file", sourceType: "url" })).rejects.toThrow();

    expect(mockWorkerStart).not.toHaveBeenCalled();
  });

  it("rejects an upload key not owned by the caller", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    // another user's prefix
    await expect(
      createJob({ source: `u/${otherUserId}/job1/file.mp4`, sourceType: "upload" }),
    ).rejects.toThrow();

    // traversal dressed up as the caller's own prefix
    await expect(
      createJob({ source: `u/${userId}/../${otherUserId}/file.mp4`, sourceType: "upload" }),
    ).rejects.toThrow();

    expect(mockWorkerStart).not.toHaveBeenCalled();
  });

  it("marks job failed when worker.start rejects", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    const balanceBefore = await balance(userId);

    let capturedJobId: string | undefined;
    mockWorkerStart.mockImplementationOnce(async (job) => {
      capturedJobId = job.id;
      throw new Error("mkdir failed");
    });

    await expect(
      createJob({ source: "https://youtube.com/watch?v=test", sourceType: "url" }),
    ).rejects.toThrow(/mkdir failed/);

    expect(capturedJobId).toBeDefined();

    const [row] = await db.select().from(jobs).where(eq(jobs.id, capturedJobId!));
    expect(row).toMatchObject({
      status: "failed",
      error: "mkdir failed",
    });

    // The job never ran -- the estimate debited before worker.start should
    // have been refunded, not left stranded (net balance unchanged).
    expect(await balance(userId)).toBe(balanceBefore);
  });

  it("rejects with a friendly message and creates no job row when balance is insufficient", async () => {
    const poorUserId = crypto.randomUUID();
    await db.insert(users).values({ id: poorUserId, email: `jobs-test-poor-${poorUserId}@example.com`, minutesBalance: 10 });
    mockAuth.mockResolvedValue({ user: { id: poorUserId } } as never);

    await expect(
      createJob({ source: "https://youtube.com/watch?v=x", sourceType: "url" }),
    ).rejects.toThrow(/Not enough minutes.*have 10.*need 30/);

    expect(mockWorkerStart).not.toHaveBeenCalled();
    const rows = await db.select().from(jobs).where(eq(jobs.userId, poorUserId));
    expect(rows).toHaveLength(0);
    expect(await balance(poorUserId)).toBe(10); // untouched

    await db.delete(users).where(eq(users.id, poorUserId));
  });

  // W9 money-leak: debit and the job-row insert used to be two separate,
  // un-transacted statements -- a failure in the insert left the debit
  // committed with no job row to hang a refund off (stranded charge). Force
  // the insert to fail (pre-seed a jobs row at the UUID crypto.randomUUID()
  // is about to hand back, so the PK collides) and prove the whole thing
  // rolls back: no charge, no orphan ledger row, createJob rejects.
  it("ATOMICITY: job-insert failure rolls back the debit -- no stranded charge", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    const balanceBefore = await balance(userId);

    const collidingJobId = crypto.randomUUID();
    await db.insert(jobs).values({
      id: collidingJobId,
      userId,
      sourceType: "url",
      sourceUrl: "https://youtube.com/watch?v=preexisting",
      status: "queued",
    });

    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(collidingJobId as `${string}-${string}-${string}-${string}-${string}`);

    try {
      await expect(
        createJob({ source: "https://youtube.com/watch?v=collision", sourceType: "url" }),
      ).rejects.toThrow();
    } finally {
      uuidSpy.mockRestore();
    }

    expect(mockWorkerStart).not.toHaveBeenCalled();

    // Charge rolled back -- balance untouched by the failed attempt.
    expect(await balance(userId)).toBe(balanceBefore);

    // No orphan job_debit ledger row for the colliding jobId (the debit's
    // own ledger insert rolled back along with the failed job insert).
    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, "job_debit"), eq(creditLedger.ref, collidingJobId)));
    expect(ledgerRows).toHaveLength(0);

    await db.delete(jobs).where(eq(jobs.id, collidingJobId));
  });
});

describe("reRenderStyle", () => {
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, email: `restyle-test-${userId}@example.com`, minutesBalance: 1000 },
      { id: otherUserId, email: `restyle-test-${otherUserId}@example.com`, minutesBalance: 1000 },
    ]);
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  beforeEach(() => {
    mockAuth.mockReset();
    mockWorkerRenderStyle.mockReset().mockResolvedValue(undefined);
  });

  async function makeJob(status: "queued" | "processing" | "done" | "failed") {
    const [job] = await db
      .insert(jobs)
      .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=x", status })
      .returning();
    return job;
  }

  it("rejects when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null as never);
    const job = await makeJob("done");

    await expect(reRenderStyle(job.id, "s2")).rejects.toThrow(/unauthorized/i);
    expect(mockWorkerRenderStyle).not.toHaveBeenCalled();
  });

  it("rejects a non-owner as not-found", async () => {
    mockAuth.mockResolvedValue({ user: { id: otherUserId } } as never);
    const job = await makeJob("done");

    await expect(reRenderStyle(job.id, "s2")).rejects.toThrow(/not found/i);
    expect(mockWorkerRenderStyle).not.toHaveBeenCalled();
  });

  it("rejects an unknown job id as not-found", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    await expect(reRenderStyle(crypto.randomUUID(), "s2")).rejects.toThrow(/not found/i);
    expect(mockWorkerRenderStyle).not.toHaveBeenCalled();
  });

  it("rejects an invalid style", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    const job = await makeJob("done");

    await expect(reRenderStyle(job.id, "s4")).rejects.toThrow(/invalid style/i);
    expect(mockWorkerRenderStyle).not.toHaveBeenCalled();
  });

  it.each(["queued", "processing", "failed"] as const)(
    "rejects when the job status is '%s' (only 'done' jobs are restyleable)",
    async (status) => {
      mockAuth.mockResolvedValue({ user: { id: userId } } as never);
      const job = await makeJob(status);

      await expect(reRenderStyle(job.id, "s2")).rejects.toThrow(/completed/i);
      expect(mockWorkerRenderStyle).not.toHaveBeenCalled();

      const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(row.status).toBe(status); // untouched -- guard runs before any write
    },
  );

  it("on a done job: flips status to processing and calls worker.renderStyle with the right args, no credit charge", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    const job = await makeJob("done");
    const balanceBefore = await balance(userId);

    await reRenderStyle(job.id, "s2");

    expect(mockWorkerRenderStyle).toHaveBeenCalledTimes(1);
    const call = mockWorkerRenderStyle.mock.calls[0][0];
    expect(call.id).toBe(job.id);
    expect(call.style).toBe("s2");
    expect(call.workdir).toContain(job.id);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("processing");

    // ponytail: restyle is free -- no debit/refund touches the balance.
    expect(await balance(userId)).toBe(balanceBefore);
  });

  it("marks the job failed when worker.renderStyle rejects", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    const job = await makeJob("done");
    mockWorkerRenderStyle.mockRejectedValueOnce(new Error("render spawn failed"));

    await expect(reRenderStyle(job.id, "s3")).rejects.toThrow(/render spawn failed/);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("render spawn failed");
  });

  it("CONCURRENCY: two concurrent reRenderStyle calls on the same done job → exactly one spawns worker, other gets not-done error", async () => {
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    const job = await makeJob("done");

    // Track which calls the mock receives (to verify exactly one succeeds).
    let renderCalls = 0;
    mockWorkerRenderStyle.mockImplementationOnce(async () => {
      renderCalls++;
    });

    // Fire two concurrent reRenderStyle calls on the same done job. The first
    // UPDATE ... WHERE status='done' will flip the status to 'processing' and
    // return the row (renderStyle gets called). The second UPDATE will see
    // status='processing' (not 'done'), return no rows, and throw "not done"
    // without spawning renderStyle.
    const [result1, result2] = await Promise.allSettled([
      reRenderStyle(job.id, "s1"),
      reRenderStyle(job.id, "s2"),
    ]);

    // Exactly one should succeed (the first one to acquire the lock).
    expect(result1.status === "fulfilled" ? 1 : 0).toEqual(1);

    // The other should reject with the not-done error.
    expect(result2.status).toBe("rejected");
    expect((result2 as any).reason.message).toMatch(/completed/i);

    // The mock should have been called exactly once (by whichever call won).
    expect(renderCalls).toBe(1);

    // Job should be in processing state (the winner flipped it).
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("processing");
  });
});
