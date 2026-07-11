import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
// createJob's own tests mock the worker singleton directly (not
// STUB_WORKER=1) so they cover the actual "did createJob call worker.start
// with the right job" contract, not just "did createJob avoid spawning".
vi.mock("@/lib/worker", () => ({ worker: { start: vi.fn().mockResolvedValue(undefined) } }));

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { jobs, users } from "@/lib/db/schema";
import { worker } from "@/lib/worker";
import { createJob } from "./jobs";

const mockAuth = vi.mocked(auth);
const mockWorkerStart = vi.mocked(worker.start);

describe("createJob", () => {
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, email: `jobs-test-${userId}@example.com` },
      { id: otherUserId, email: `jobs-test-${otherUserId}@example.com` },
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
  });
});
