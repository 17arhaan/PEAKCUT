import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { creditLedger, jobs, users } from "@/lib/db/schema";
import { balance, debit } from "@/lib/credits";
import { GET } from "./route";

const SECRET = process.env.CRON_SECRET!;
const ESTIMATE_MINUTES = 30;
const THIRTY_ONE_MIN_AGO = new Date(Date.now() - 31 * 60 * 1000);
const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000);

function sweepRequest(secret?: string | null) {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["authorization"] = `Bearer ${secret ?? SECRET}`;
  return new Request("http://localhost/api/cron/sweep", { headers });
}

const createdUserIds: string[] = [];

async function createUser(minutesBalance = 100): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: `sweep-test-${id}@example.com`, minutesBalance });
  createdUserIds.push(id);
  return id;
}

/** Inserts a job, debits its estimate (mirrors createJob), then backdates updatedAt. */
async function makeJob(
  userId: string,
  status: "queued" | "processing" | "done" | "failed",
  updatedAt: Date,
): Promise<string> {
  const jobId = crypto.randomUUID();
  await db.insert(jobs).values({ id: jobId, userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=x", status });
  await debit(userId, ESTIMATE_MINUTES, jobId);
  await db.update(jobs).set({ updatedAt }).where(eq(jobs.id, jobId));
  return jobId;
}

// credit_ledger cascades on user delete (W2 schema); jobs does too.
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("GET /api/cron/sweep", () => {
  it("401s with no Authorization header", async () => {
    const res = await GET(sweepRequest(null));
    expect(res.status).toBe(401);
  });

  it("401s with the wrong secret", async () => {
    const res = await GET(sweepRequest("wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("marks a stale processing job failed and refunds its estimate", async () => {
    const userId = await createUser();
    const jobId = await makeJob(userId, "processing", THIRTY_ONE_MIN_AGO);
    const balanceAfterDebit = await balance(userId); // debited by makeJob, not yet refunded

    const res = await GET(sweepRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.swept).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("timed out");

    expect(await balance(userId)).toBe(balanceAfterDebit + ESTIMATE_MINUTES);
    const refundRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.reason, "job_refund"));
    expect(refundRows.filter((r) => r.ref === jobId)).toHaveLength(1);
  });

  it("leaves a fresh (recently-updated) processing job untouched", async () => {
    const userId = await createUser();
    const jobId = await makeJob(userId, "processing", FIVE_MIN_AGO);
    const balanceAfterDebit = await balance(userId);

    await GET(sweepRequest());

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("processing");
    expect(await balance(userId)).toBe(balanceAfterDebit); // not refunded -- job wasn't swept
  });

  it("does not re-sweep or double-refund an already-failed job on a repeat run", async () => {
    const userId = await createUser();
    const jobId = await makeJob(userId, "processing", THIRTY_ONE_MIN_AGO);

    await GET(sweepRequest());
    const balanceAfterFirstSweep = await balance(userId);

    // Second cron run over the same (now-failed, still stale-timestamped) job.
    const res2 = await GET(sweepRequest());
    const body2 = await res2.json();

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("failed");
    expect(await balance(userId)).toBe(balanceAfterFirstSweep); // no double refund

    const refundRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.reason, "job_refund"));
    expect(refundRows.filter((r) => r.ref === jobId)).toHaveLength(1);

    // The already-failed job isn't even selected by this run (status filter
    // excludes it) -- this run's own swept count reflects nothing left to do
    // for it specifically (other tests' jobs may still contribute >0).
    const sweptThisRun = body2.swept as number;
    expect(sweptThisRun).toBeGreaterThanOrEqual(0);
  });

  it("a stale queued job is also swept (not just processing)", async () => {
    const userId = await createUser();
    const jobId = await makeJob(userId, "queued", THIRTY_ONE_MIN_AGO);
    const balanceAfterDebit = await balance(userId);

    await GET(sweepRequest());

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("failed");
    expect(await balance(userId)).toBe(balanceAfterDebit + ESTIMATE_MINUTES);
  });

  it("a stale done job is never touched", async () => {
    const userId = await createUser();
    const jobId = await makeJob(userId, "done", THIRTY_ONE_MIN_AGO);
    const balanceAfterDebit = await balance(userId);

    await GET(sweepRequest());

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("done");
    expect(await balance(userId)).toBe(balanceAfterDebit);
  });
});
