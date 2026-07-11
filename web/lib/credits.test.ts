import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { creditLedger, users } from "@/lib/db/schema";
import {
  InsufficientCreditsError,
  balance,
  debit,
  grantSignup,
  ledgerSum,
  reconcile,
  refund,
} from "@/lib/credits";

const createdUserIds: string[] = [];

async function createUser(minutesBalance = 0): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: `credits-test-${id}@example.com`, minutesBalance });
  createdUserIds.push(id);
  return id;
}

async function ledgerRowsFor(userId: string, reason: string) {
  return db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.reason, reason)));
}

// credit_ledger.user_id cascades on user delete (W2 schema), so deleting
// the users this file created cleans up every ledger row too.
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("grantSignup", () => {
  it("is idempotent: a second call for the same user is a no-op", async () => {
    const userId = await createUser(0);

    await grantSignup(userId);
    await grantSignup(userId);

    expect(await balance(userId)).toBe(60);
    expect(await ledgerRowsFor(userId, "signup_grant")).toHaveLength(1);
  });
});

describe("debit", () => {
  it("sufficient balance: decrements balance and records a job_debit ledger row", async () => {
    const userId = await createUser(100);
    const jobId = crypto.randomUUID();

    const { balance: b } = await debit(userId, 30, jobId);

    expect(b).toBe(70);
    expect(await balance(userId)).toBe(70);
    const rows = await ledgerRowsFor(userId, "job_debit");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref: jobId, deltaMinutes: -30 });
  });

  it("insufficient balance: throws, balance unchanged, no ledger row", async () => {
    const userId = await createUser(10);
    const jobId = crypto.randomUUID();

    await expect(debit(userId, 30, jobId)).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(await balance(userId)).toBe(10);
    expect(await ledgerRowsFor(userId, "job_debit")).toHaveLength(0);
  });

  it("the same jobId debited twice is charged only once (idempotent retry)", async () => {
    const userId = await createUser(100);
    const jobId = crypto.randomUUID();

    await debit(userId, 30, jobId);
    await debit(userId, 30, jobId);

    expect(await balance(userId)).toBe(70);
    expect(await ledgerRowsFor(userId, "job_debit")).toHaveLength(1);
  });

  // The whole point of this file: two concurrent debits against a balance
  // that can only cover one of them must never both succeed and must never
  // drive the balance negative. Both promises are constructed up front (not
  // sequentially awaited) so they genuinely race inside Postgres, not just
  // inside this process -- the guard that makes this safe is the single
  // atomic `UPDATE ... WHERE minutes_balance >= m` in lib/credits.ts, not
  // anything in this test.
  it("CONCURRENCY: two parallel debits exceeding balance -- exactly one succeeds, balance never negative", async () => {
    const userId = await createUser(50);
    const jobA = crypto.randomUUID();
    const jobB = crypto.randomUUID();

    const [a, b] = await Promise.allSettled([debit(userId, 40, jobA), debit(userId, 40, jobB)]);

    const outcomes = [a, b];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);

    const finalBalance = await balance(userId);
    expect(finalBalance).toBe(10); // 50 - 40, exactly one debit landed
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    // The loser's tx rolled back entirely -- its ledger insert never
    // persisted, so only the winner's row survives.
    const rows = await ledgerRowsFor(userId, "job_debit");
    expect(rows).toHaveLength(1);
  });
});

describe("refund", () => {
  it("is idempotent: a second refund for the same job is a no-op", async () => {
    const userId = await createUser(50);
    const jobId = crypto.randomUUID();

    await refund(userId, jobId, 20);
    await refund(userId, jobId, 20);

    expect(await balance(userId)).toBe(70);
    expect(await ledgerRowsFor(userId, "job_refund")).toHaveLength(1);
  });
});

describe("reconcile", () => {
  it("actual < estimate: partial refund, net charge equals actual", async () => {
    const userId = await createUser(100);
    const jobId = crypto.randomUUID();
    await debit(userId, 30, jobId);

    await reconcile(userId, jobId, 10);

    expect(await balance(userId)).toBe(90); // 100 - 10 net
  });

  it("actual > estimate with enough balance left: additional debit, net charge equals actual", async () => {
    const userId = await createUser(100);
    const jobId = crypto.randomUUID();
    await debit(userId, 30, jobId);

    await reconcile(userId, jobId, 45);

    expect(await balance(userId)).toBe(55); // 100 - 45 net
  });

  it("actual > estimate beyond remaining balance: caps the extra debit instead of throwing", async () => {
    const userId = await createUser(35);
    const jobId = crypto.randomUUID();
    await debit(userId, 30, jobId); // balance now 5

    await expect(reconcile(userId, jobId, 100)).resolves.toMatchObject({ balance: 0 });

    expect(await balance(userId)).toBe(0); // capped, never negative
  });

  it("is idempotent: a second reconcile for the same job is a no-op", async () => {
    const userId = await createUser(100);
    const jobId = crypto.randomUUID();
    await debit(userId, 30, jobId);

    await reconcile(userId, jobId, 10);
    await reconcile(userId, jobId, 10);

    expect(await balance(userId)).toBe(90);
    expect(await ledgerRowsFor(userId, "job_reconcile")).toHaveLength(1);
  });
});

describe("cache == ledger truth", () => {
  it("balance() matches ledgerSum() after a debit+refund+reconcile sequence", async () => {
    const userId = await createUser(0);
    await grantSignup(userId); // balance 60, fully ledger-backed

    const jobA = crypto.randomUUID();
    const jobB = crypto.randomUUID();
    await debit(userId, 30, jobA); // 30
    await debit(userId, 20, jobB); // 10
    await refund(userId, jobB, 20); // 30 -- jobB never ran, full refund
    await reconcile(userId, jobA, 25); // 35 -- jobA's estimate (30) was 5 over actual (25)

    const b = await balance(userId);
    const s = await ledgerSum(userId);
    expect(b).toBe(35);
    expect(s).toBe(b);
  });
});
