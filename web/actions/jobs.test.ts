import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
// createJob's own tests mock the worker singleton directly (not
// STUB_WORKER=1) so they cover the actual "did createJob call worker.start
// with the right job" contract, not just "did createJob avoid spawning".
vi.mock("@/lib/worker", () => ({ worker: { start: vi.fn().mockResolvedValue(undefined) } }));

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { creditLedger, jobs, users } from "@/lib/db/schema";
import { worker } from "@/lib/worker";
import { balance } from "@/lib/credits";
import { createJob } from "./jobs";

const mockAuth = vi.mocked(auth);
const mockWorkerStart = vi.mocked(worker.start);

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
