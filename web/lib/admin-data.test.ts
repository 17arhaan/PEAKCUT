import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { clips, creditLedger, jobs, payments, users } from "@/lib/db/schema";
import {
  getAdminOverview,
  getRecentFailures,
  getRecentJobs,
  getRecentSignups,
} from "@/lib/admin-data";

// These aggregates are global (no userId scope -- that's the whole point of
// an admin dashboard), and this test DB is shared with every other test
// file. So assertions are DELTA-based (before/after seeding), never
// absolute counts -- the only way to make this robust against whatever
// other rows happen to exist.
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("getAdminOverview", () => {
  it("aggregates correctly across 2 seeded users with jobs/clips/payments", async () => {
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    createdUserIds.push(userA, userB);

    // Runs before-snapshot, inserts, and after-snapshot inside ONE
    // REPEATABLE READ transaction: this test DB is shared with every other
    // test file running concurrently (vitest parallelizes across files), so
    // a plain two-round-trip before/after would race against their inserts.
    // Under REPEATABLE READ, every read in this tx sees one consistent
    // snapshot (as of the first query) plus this tx's own writes -- other
    // transactions committing concurrently are invisible here, so the
    // delta below is exactly our seeded rows, deterministically.
    const { before, after } = await db.transaction(
      async (tx) => {
        const before = await getAdminOverview(tx);

        await tx.insert(users).values([
          { id: userA, email: `admin-data-a-${userA}@example.com`, minutesBalance: 40 },
          { id: userB, email: `admin-data-b-${userB}@example.com`, minutesBalance: 15 },
        ]);

        const [doneJob] = await tx
          .insert(jobs)
          .values({
            userId: userA,
            sourceType: "url",
            sourceUrl: "https://youtube.com/watch?v=admin-data-test",
            status: "done",
            durationMin: 10,
            costCents: 250,
          })
          .returning();

        await tx.insert(jobs).values([
          { userId: userA, sourceType: "url", status: "failed", error: "boom", costCents: 50 },
          { userId: userB, sourceType: "upload", status: "queued" },
        ]);

        await tx.insert(clips).values([
          { jobId: doneJob.id, clipIndex: 1, tStart: 0, tEnd: 5, status: "ready" },
          { jobId: doneJob.id, clipIndex: 2, tStart: 5, tEnd: 10, status: "dropped", droppedReason: "BLACK" },
        ]);

        await tx.insert(payments).values({
          userId: userA,
          morEventId: `admin-data-payment-${userA}`,
          amountCents: 1999,
          currency: "usd",
        });

        await tx.insert(creditLedger).values([
          { userId: userA, deltaMinutes: 60, reason: "signup_grant", ref: userA },
          { userId: userA, deltaMinutes: -20, reason: "job_debit", ref: doneJob.id },
          { userId: userB, deltaMinutes: 60, reason: "signup_grant", ref: userB },
        ]);

        const after = await getAdminOverview(tx);
        return { before, after };
      },
      { isolationLevel: "repeatable read" },
    );

    expect(after.totalUsers - before.totalUsers).toBe(2);
    expect(after.totalJobs - before.totalJobs).toBe(3);
    expect(after.jobsByStatus.done - before.jobsByStatus.done).toBe(1);
    expect(after.jobsByStatus.failed - before.jobsByStatus.failed).toBe(1);
    expect(after.jobsByStatus.queued - before.jobsByStatus.queued).toBe(1);
    expect(after.totalVideosProcessed - before.totalVideosProcessed).toBe(1);
    expect(after.totalClips - before.totalClips).toBe(2);
    expect(after.totalCostCents - before.totalCostCents).toBe(300); // 250 + 50
    expect(after.creditsOutstandingMinutes - before.creditsOutstandingMinutes).toBe(55); // 40 + 15
    expect(after.minutesGranted - before.minutesGranted).toBe(120); // 60 + 60
    expect(after.minutesSpent - before.minutesSpent).toBe(20);
    expect(after.revenueCents - before.revenueCents).toBe(1999);
    expect(after.payingUsers - before.payingUsers).toBe(1);
  });
});

describe("getRecentJobs / getRecentSignups / getRecentFailures", () => {
  it("include the seeded cross-user rows with the owning user's email", async () => {
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    createdUserIds.push(userA, userB);
    const emailA = `admin-data-recent-a-${userA}@example.com`;
    const emailB = `admin-data-recent-b-${userB}@example.com`;

    await db.insert(users).values([
      { id: userA, email: emailA },
      { id: userB, email: emailB },
    ]);

    const [job] = await db
      .insert(jobs)
      .values({ userId: userA, sourceType: "url", sourceUrl: "https://youtube.com/x", status: "queued" })
      .returning();
    const [failedJob] = await db
      .insert(jobs)
      .values({ userId: userB, sourceType: "upload", status: "failed", error: "transcode failed" })
      .returning();

    const recentJobs = await getRecentJobs();
    const recentSignups = await getRecentSignups();
    const recentFailures = await getRecentFailures();

    expect(recentJobs.find((r) => r.id === job.id)).toMatchObject({ userEmail: emailA, status: "queued" });
    expect(recentSignups.find((r) => r.email === emailA)).toBeTruthy();
    expect(recentSignups.find((r) => r.email === emailB)).toBeTruthy();
    expect(recentFailures.find((r) => r.id === failedJob.id)).toMatchObject({
      userEmail: emailB,
      error: "transcode failed",
    });
  });
});
