import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { delete: vi.fn().mockResolvedValue(undefined) } }));

import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import {
  accounts,
  agentEvents,
  clips,
  creditLedger,
  jobs,
  payments,
  sessions,
  users,
} from "@/lib/db/schema";
import { storage } from "@/lib/storage";
import { deleteAccount } from "./account";

const mockAuth = vi.mocked(auth);
const mockSignOut = vi.mocked(signOut);
const mockStorageDelete = vi.mocked(storage.delete);

/**
 * Seeds a full "user with data" tree: job, clip, an agent_event tied to the
 * job AND one tied to the clip (agent_events.clipId is a second cascade
 * path worth covering separately from jobId), a credit_ledger row, a
 * payments row, and an Auth.js account + session row. Mirrors every table
 * deleteAccount's docstring claims cascades off users.id.
 */
async function seedUserWithData(emailPrefix: string) {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${emailPrefix}-${userId}@example.com`,
    minutesBalance: 100,
  });

  const [job] = await db
    .insert(jobs)
    .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=x", status: "done" })
    .returning();

  const [clip] = await db
    .insert(clips)
    .values({ jobId: job.id, clipIndex: 0, tStart: 0, tEnd: 10, status: "ready" })
    .returning();

  await db.insert(agentEvents).values([
    { jobId: job.id, agent: "ingest", action: "start" },
    { jobId: job.id, clipId: clip.id, agent: "crew", action: "score" },
  ]);

  await db.insert(creditLedger).values({
    userId,
    deltaMinutes: -30,
    reason: "job_debit",
    ref: job.id,
  });

  await db.insert(payments).values({
    userId,
    morEventId: crypto.randomUUID(),
    amountCents: 999,
    currency: "usd",
  });

  await db.insert(accounts).values({
    userId,
    type: "oauth",
    provider: "google",
    providerAccountId: crypto.randomUUID(),
  });

  await db.insert(sessions).values({
    sessionToken: crypto.randomUUID(),
    userId,
    expires: new Date(Date.now() + 86_400_000),
  });

  return { userId, jobId: job.id, clipId: clip.id };
}

async function rowCounts(userId: string, jobId: string, clipId: string) {
  return {
    user: (await db.select().from(users).where(eq(users.id, userId))).length,
    jobs: (await db.select().from(jobs).where(eq(jobs.userId, userId))).length,
    clips: (await db.select().from(clips).where(eq(clips.jobId, jobId))).length,
    agentEventsByJob: (await db.select().from(agentEvents).where(eq(agentEvents.jobId, jobId))).length,
    agentEventsByClip: (await db.select().from(agentEvents).where(eq(agentEvents.clipId, clipId))).length,
    ledger: (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).length,
    payments: (await db.select().from(payments).where(eq(payments.userId, userId))).length,
    accounts: (await db.select().from(accounts).where(eq(accounts.userId, userId))).length,
    sessions: (await db.select().from(sessions).where(eq(sessions.userId, userId))).length,
  };
}

// Users the "rejects when unauthenticated" test's user cleanup, and any
// user seeded by a test that throws before deleteAccount runs.
const cleanupUserIds: string[] = [];

afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("deleteAccount", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockSignOut.mockReset().mockResolvedValue(undefined as never);
    mockStorageDelete.mockReset().mockResolvedValue(undefined);
  });

  it("rejects when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null as never);

    await expect(deleteAccount()).rejects.toThrow(/unauthorized/i);

    expect(mockStorageDelete).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("removes the user + all their jobs/clips/agent_events/ledger/payments/accounts/sessions rows, purges storage under the caller's own prefix, and signs out", async () => {
    const { userId, jobId, clipId } = await seedUserWithData("solo");
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    const before = await rowCounts(userId, jobId, clipId);
    expect(before).toMatchObject({
      user: 1,
      jobs: 1,
      clips: 1,
      agentEventsByJob: 2,
      agentEventsByClip: 1,
      ledger: 1,
      payments: 1,
      accounts: 1,
      sessions: 1,
    });

    await deleteAccount();

    const after = await rowCounts(userId, jobId, clipId);
    expect(after).toMatchObject({
      user: 0,
      jobs: 0,
      clips: 0,
      agentEventsByJob: 0,
      agentEventsByClip: 0,
      ledger: 0,
      payments: 0,
      accounts: 0,
      sessions: 0,
    });

    // storage.delete is called with exactly the caller's own u/<userId>
    // prefix -- built from the session, never a parameter.
    expect(mockStorageDelete).toHaveBeenCalledTimes(1);
    expect(mockStorageDelete).toHaveBeenCalledWith(`u/${userId}`);

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ redirectTo: "/" });
  });

  // SECURITY CORE: a user deleting their own account must never touch
  // another user's rows or files. Seed TWO users each with a full data
  // tree, delete only A, assert A is gone in full and B survives in full.
  it("CROSS-USER ISOLATION: deleting user A's account leaves user B's rows and files completely untouched", async () => {
    const a = await seedUserWithData("cross-a");
    const b = await seedUserWithData("cross-b");
    cleanupUserIds.push(b.userId); // survives this test; swept in afterAll

    mockAuth.mockResolvedValue({ user: { id: a.userId } } as never);

    await deleteAccount();

    const afterA = await rowCounts(a.userId, a.jobId, a.clipId);
    expect(afterA).toMatchObject({
      user: 0,
      jobs: 0,
      clips: 0,
      agentEventsByJob: 0,
      agentEventsByClip: 0,
      ledger: 0,
      payments: 0,
      accounts: 0,
      sessions: 0,
    });

    const afterB = await rowCounts(b.userId, b.jobId, b.clipId);
    expect(afterB).toMatchObject({
      user: 1,
      jobs: 1,
      clips: 1,
      agentEventsByJob: 2,
      agentEventsByClip: 1,
      ledger: 1,
      payments: 1,
      accounts: 1,
      sessions: 1,
    });

    // storage.delete was called with A's prefix only -- never B's.
    expect(mockStorageDelete).toHaveBeenCalledTimes(1);
    expect(mockStorageDelete).toHaveBeenCalledWith(`u/${a.userId}`);
    expect(mockStorageDelete).not.toHaveBeenCalledWith(`u/${b.userId}`);
  });

  it("no-ops (doesn't throw) for a user with no jobs and nothing uploaded", async () => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: `empty-${userId}@example.com` });
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);

    await expect(deleteAccount()).resolves.toBeUndefined();

    expect(mockStorageDelete).toHaveBeenCalledWith(`u/${userId}`);
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row).toBeUndefined();
  });

  it("propagates a storage.delete failure without silently succeeding, but still signs out (W12 hardening)", async () => {
    const { userId, jobId } = await seedUserWithData("storage-fail");
    mockAuth.mockResolvedValue({ user: { id: userId } } as never);
    mockStorageDelete.mockRejectedValueOnce(new Error("disk error"));

    await expect(deleteAccount()).rejects.toThrow(/disk error/);

    // The DB side already committed before the storage step runs -- the
    // user row purge isn't rolled back by a later storage failure.
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row).toBeUndefined();

    // A deleted user must never keep a valid session cookie just because
    // storage cleanup failed -- signOut runs regardless.
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ redirectTo: "/" });
    void jobId;
  });
});
