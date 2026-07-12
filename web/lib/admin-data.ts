import { count, countDistinct, desc, eq, gt, gte, lt, sum } from "drizzle-orm";
import { db, type Db } from "@/lib/db";
import { clips, creditLedger, jobs, payments, users } from "@/lib/db/schema";

// SECURITY: every export below queries across ALL users -- no userId scope.
// The caller MUST have already verified isAdmin(await auth()) before calling
// anything in this file (see app/admin/page.tsx). These functions do not
// re-check admin status themselves -- they are not safe to call from
// anywhere that skips that check.

const RECENT_LIMIT = 25;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function sevenDaysAgo(): Date {
  return new Date(Date.now() - SEVEN_DAYS_MS);
}

// drizzle's sum() decodes as string (Postgres numeric/bigint safety); null
// when no rows match. Number(x ?? 0) collapses both null and numeric
// strings to a plain JS number.
function numeric(value: string | null): number {
  return Number(value ?? 0);
}

export interface AdminOverview {
  totalUsers: number;
  signupsLast7Days: number;
  totalJobs: number;
  jobsByStatus: Record<"queued" | "processing" | "done" | "failed", number>;
  totalVideosProcessed: number;
  totalClips: number;
  totalCostCents: number;
  costCentsLast7Days: number;
  creditsOutstandingMinutes: number;
  minutesGranted: number;
  minutesSpent: number;
  revenueCents: number;
  payingUsers: number;
}

/**
 * Cross-user overview stats for the admin dashboard's stat cards. Takes an
 * optional `tx` (same style as lib/credits.ts) so callers/tests can run it
 * inside a REPEATABLE READ transaction for a consistent snapshot -- not
 * needed in production (db default is fine), but it's what lets
 * admin-data.test.ts assert exact before/after deltas on a test DB shared
 * with every other test file running concurrently.
 *
 * ponytail: the Promise.all below fires all 12 queries concurrently, which
 * is fine against the default `db` Pool (each grabs its own connection) but
 * emits a benign pg deprecation warning when a single-connection `tx` is
 * passed in (queries queue instead of truly overlapping) -- only the test
 * path does that. Switch to sequential awaits inside this function if pg
 * ever hard-removes that queueing behavior.
 */
export async function getAdminOverview(tx: Db = db): Promise<AdminOverview> {
  const since = sevenDaysAgo();

  const [
    [{ totalUsers }],
    [{ signupsLast7Days }],
    jobStatusRows,
    [{ totalVideosProcessed }],
    [{ totalClips }],
    [{ totalCostCents }],
    [{ costCentsLast7Days }],
    [{ creditsOutstandingMinutes }],
    [{ minutesGranted }],
    [{ minutesSpent }],
    [{ revenueCents }],
    [{ payingUsers }],
  ] = await Promise.all([
    tx.select({ totalUsers: count() }).from(users),
    tx.select({ signupsLast7Days: count() }).from(users).where(gte(users.createdAt, since)),
    tx.select({ status: jobs.status, n: count() }).from(jobs).groupBy(jobs.status),
    tx.select({ totalVideosProcessed: count() }).from(jobs).where(eq(jobs.status, "done")),
    tx.select({ totalClips: count() }).from(clips),
    tx.select({ totalCostCents: sum(jobs.costCents) }).from(jobs),
    tx
      .select({ costCentsLast7Days: sum(jobs.costCents) })
      .from(jobs)
      .where(gte(jobs.createdAt, since)),
    tx.select({ creditsOutstandingMinutes: sum(users.minutesBalance) }).from(users),
    tx
      .select({ minutesGranted: sum(creditLedger.deltaMinutes) })
      .from(creditLedger)
      .where(gt(creditLedger.deltaMinutes, 0)),
    tx
      .select({ minutesSpent: sum(creditLedger.deltaMinutes) })
      .from(creditLedger)
      .where(lt(creditLedger.deltaMinutes, 0)),
    tx.select({ revenueCents: sum(payments.amountCents) }).from(payments),
    tx.select({ payingUsers: countDistinct(payments.userId) }).from(payments),
  ]);

  const jobsByStatus: AdminOverview["jobsByStatus"] = { queued: 0, processing: 0, done: 0, failed: 0 };
  for (const row of jobStatusRows) {
    if (row.status in jobsByStatus) jobsByStatus[row.status] = row.n;
  }

  return {
    totalUsers,
    signupsLast7Days,
    totalJobs: jobStatusRows.reduce((sumN, r) => sumN + r.n, 0),
    jobsByStatus,
    totalVideosProcessed,
    totalClips,
    totalCostCents: numeric(totalCostCents),
    costCentsLast7Days: numeric(costCentsLast7Days),
    creditsOutstandingMinutes: numeric(creditsOutstandingMinutes),
    minutesGranted: numeric(minutesGranted),
    // deltaMinutes < 0 rows summed above are negative -- flip sign to a spent amount.
    minutesSpent: -numeric(minutesSpent),
    revenueCents: numeric(revenueCents),
    payingUsers,
  };
}

export interface AdminJobRow {
  id: string;
  userEmail: string;
  sourceType: "url" | "upload";
  sourceUrl: string | null;
  status: "queued" | "processing" | "done" | "failed";
  durationMin: number | null;
  costCents: number | null;
  createdAt: Date;
}

/** Newest jobs across all users, capped at RECENT_LIMIT. */
export async function getRecentJobs(): Promise<AdminJobRow[]> {
  const rows = await db
    .select({
      id: jobs.id,
      userEmail: users.email,
      sourceType: jobs.sourceType,
      sourceUrl: jobs.sourceUrl,
      status: jobs.status,
      durationMin: jobs.durationMin,
      costCents: jobs.costCents,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(users, eq(jobs.userId, users.id))
    .orderBy(desc(jobs.createdAt))
    .limit(RECENT_LIMIT);
  return rows;
}

export interface AdminSignupRow {
  id: string;
  email: string;
  plan: string;
  minutesBalance: number;
  createdAt: Date;
}

/** Newest signups across all users, capped at RECENT_LIMIT. */
export async function getRecentSignups(): Promise<AdminSignupRow[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      plan: users.plan,
      minutesBalance: users.minutesBalance,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(RECENT_LIMIT);
}

export interface AdminFailureRow {
  id: string;
  userEmail: string;
  sourceType: "url" | "upload";
  sourceUrl: string | null;
  error: string | null;
  createdAt: Date;
}

/** Newest failed jobs across all users -- the operator's triage list. */
export async function getRecentFailures(): Promise<AdminFailureRow[]> {
  return db
    .select({
      id: jobs.id,
      userEmail: users.email,
      sourceType: jobs.sourceType,
      sourceUrl: jobs.sourceUrl,
      error: jobs.error,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(users, eq(jobs.userId, users.id))
    .where(eq(jobs.status, "failed"))
    .orderBy(desc(jobs.createdAt))
    .limit(RECENT_LIMIT);
}

// admin actions (grant credits, delete user) -- future
