import { and, eq, gte, sql } from "drizzle-orm";
import { db, type Db } from "@/lib/db";
import { creditLedger, users } from "@/lib/db/schema";

/**
 * The atomic credits ledger (spec §7 / plan Global Constraints). `credit_ledger`
 * is the source of truth; `users.minutes_balance` is a cache kept in lockstep
 * in the SAME transaction as every ledger insert -- they must never diverge.
 * Idempotency for every reason is the ledger's UNIQUE(reason, ref) constraint:
 * insert first (the idempotency gate), only mutate balance if that insert
 * actually landed a new row.
 *
 * minutes_balance is an integer column (frozen W2 schema) while
 * credit_ledger.delta_minutes is real -- so every amount that crosses this
 * module is rounded to whole minutes before it's written anywhere. That's
 * what keeps `ledgerSum(userId) === balance(userId)` exactly, not just
 * approximately, even when reconcile's actual-minutes input is fractional.
 */

const SIGNUP_GRANT_MINUTES = 60;
const SIGNUP_GRANT_REASON = "signup_grant";
const JOB_DEBIT_REASON = "job_debit";
const JOB_REFUND_REASON = "job_refund";
const JOB_RECONCILE_REASON = "job_reconcile";

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly available: number,
    public readonly required: number,
  ) {
    super(`insufficient credits: have ${available}, need ${required}`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * +60min one-time signup grant. Idempotent on (reason='signup_grant',
 * ref=userId) -- a second call for the same user is a no-op, balance only
 * bumps if the ledger insert actually landed. Takes an optional `tx` so
 * auth.ts can call this from inside its own user-creation transaction
 * (grant and user-row-creation commit or roll back together).
 */
export async function grantSignup(userId: string, tx: Db = db): Promise<void> {
  const [grant] = await tx
    .insert(creditLedger)
    .values({ userId, deltaMinutes: SIGNUP_GRANT_MINUTES, reason: SIGNUP_GRANT_REASON, ref: userId })
    .onConflictDoNothing({ target: [creditLedger.reason, creditLedger.ref] })
    .returning();

  if (grant) {
    await tx
      .update(users)
      .set({ minutesBalance: sql`${users.minutesBalance} + ${SIGNUP_GRANT_MINUTES}` })
      .where(eq(users.id, userId));
  }
}

/**
 * Atomically debits `minutes` from userId's balance for jobId, recording it
 * in the ledger in the same tx. The ledger insert (idempotency gate) happens
 * FIRST: if a job_debit row for this jobId already exists, this is a retried
 * debit for a job we already charged -- return the current balance without
 * touching it. Only past that gate do we attempt the balance decrement,
 * via a single guarded UPDATE (`WHERE minutes_balance >= m`) so two
 * concurrent debits against the same balance can't both observe "enough"
 * and both write -- Postgres locks the row per-statement and the second
 * writer re-checks the guard against the first writer's committed value
 * before deciding whether it still qualifies. If the guard fails, we throw
 * and the whole tx (including the ledger insert) rolls back -- no orphaned
 * ledger row, no balance change.
 *
 * Takes an optional `tx`, same style as grantSignup: pass one in to have the
 * debit participate in a caller's own transaction (e.g. jobs.ts wants the
 * debit and the job-row insert to commit or roll back together). With no
 * `tx`, debit opens its own transaction so it's still atomic standalone.
 */
export async function debit(
  userId: string,
  minutes: number,
  jobId: string,
  tx?: Db,
): Promise<{ balance: number }> {
  const m = Math.round(minutes);

  const run = async (t: Db): Promise<{ balance: number }> => {
    const [ledgerRow] = await t
      .insert(creditLedger)
      .values({ userId, deltaMinutes: -m, reason: JOB_DEBIT_REASON, ref: jobId })
      .onConflictDoNothing({ target: [creditLedger.reason, creditLedger.ref] })
      .returning();

    if (!ledgerRow) {
      const [row] = await t.select({ balance: users.minutesBalance }).from(users).where(eq(users.id, userId));
      return { balance: row?.balance ?? 0 };
    }

    const [updated] = await t
      .update(users)
      .set({ minutesBalance: sql`${users.minutesBalance} - ${m}` })
      .where(and(eq(users.id, userId), gte(users.minutesBalance, m)))
      .returning({ balance: users.minutesBalance });

    if (!updated) {
      const [row] = await t.select({ balance: users.minutesBalance }).from(users).where(eq(users.id, userId));
      throw new InsufficientCreditsError(row?.balance ?? 0, m);
    }

    return { balance: updated.balance };
  };

  return tx ? run(tx) : db.transaction(run);
}

/**
 * Refunds `minutes` back to userId for jobId. Idempotent on (reason, ref) --
 * a second refund for the same job (default reason 'job_refund') is a
 * no-op, balance only bumps if the ledger insert actually landed. Refunding
 * can never fail a balance guard (it only ever adds).
 */
export async function refund(
  userId: string,
  jobId: string,
  minutes: number,
  reason: string = JOB_REFUND_REASON,
): Promise<{ balance: number }> {
  const m = Math.round(minutes);

  return db.transaction(async (tx) => {
    const [ledgerRow] = await tx
      .insert(creditLedger)
      .values({ userId, deltaMinutes: m, reason, ref: jobId })
      .onConflictDoNothing({ target: [creditLedger.reason, creditLedger.ref] })
      .returning();

    if (!ledgerRow) {
      const [row] = await tx.select({ balance: users.minutesBalance }).from(users).where(eq(users.id, userId));
      return { balance: row?.balance ?? 0 };
    }

    const [updated] = await tx
      .update(users)
      .set({ minutesBalance: sql`${users.minutesBalance} + ${m}` })
      .where(eq(users.id, userId))
      .returning({ balance: users.minutesBalance });

    return { balance: updated?.balance ?? 0 };
  });
}

/**
 * Reads the estimate (whole minutes) that was originally debited for jobId,
 * or 0 if none. UNIQUE(reason, ref) means at most one job_debit row can
 * ever exist for a jobId -- the orderBy + limit(1) just makes that "one
 * debit per job" invariant explicit at the call site instead of relying on
 * the destructure to quietly pick whichever row Postgres returns first.
 */
async function estimateFor(tx: Db, userId: string, jobId: string): Promise<number> {
  const [row] = await tx
    .select({ delta: creditLedger.deltaMinutes })
    .from(creditLedger)
    .where(
      and(eq(creditLedger.userId, userId), eq(creditLedger.reason, JOB_DEBIT_REASON), eq(creditLedger.ref, jobId)),
    )
    .orderBy(creditLedger.createdAt)
    .limit(1);
  return row ? Math.round(-row.delta) : 0;
}

/** Public lookup for callers outside this module (e.g. run-import's failure path) that need the original estimate to refund. */
export async function estimatedMinutesFor(userId: string, jobId: string): Promise<number> {
  return estimateFor(db, userId, jobId);
}

/**
 * Corrects a job's charge from its debit-time estimate to actual usage,
 * once the job finishes. Computes delta = estimate - actual against the
 * existing job_debit ledger row: positive -> partial refund, negative ->
 * additional debit. Idempotent on (reason='job_reconcile', ref=jobId).
 *
 * Policy: reconcile NEVER fails the job over money. If actual > estimate and
 * the user doesn't have enough balance left to cover the extra debit, cap
 * the charge at whatever balance remains (log it) instead of throwing --
 * the job already ran and its result already exists; erroring here would
 * only strand a finished job behind a credits bug.
 */
export async function reconcile(userId: string, jobId: string, actualMinutes: number): Promise<{ balance: number }> {
  const actual = Math.round(actualMinutes);

  return db.transaction(async (tx) => {
    const estimate = await estimateFor(tx, userId, jobId);
    const correction = estimate - actual;

    if (correction === 0) {
      const [row] = await tx.select({ balance: users.minutesBalance }).from(users).where(eq(users.id, userId));
      return { balance: row?.balance ?? 0 };
    }

    // Lock the user row before deciding whether to cap: without the lock, a
    // concurrent mutation between reading the balance and applying the
    // (possibly capped) correction could still push it negative.
    const [locked] = await tx
      .select({ balance: users.minutesBalance })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    const currentBalance = locked?.balance ?? 0;

    let applied = correction;
    if (correction < 0 && currentBalance + correction < 0) {
      applied = -currentBalance; // cap: charge only what's left, floor balance at 0
      console.warn(
        `[credits] reconcile for job ${jobId}: wanted to charge ${-correction} extra minute(s) but only ${currentBalance} left -- capped`,
      );
    }

    if (applied === 0) {
      // Capped away to nothing (e.g. no balance left to take the extra
      // debit from) -- balance doesn't move, but still write a zero-delta
      // job_reconcile row (idempotent on the same (reason, ref) as a real
      // correction) so "ledger is truth" holds: a reconciled job always has
      // a ledger trace, even when the correction nets to nothing.
      await tx
        .insert(creditLedger)
        .values({ userId, deltaMinutes: 0, reason: JOB_RECONCILE_REASON, ref: jobId })
        .onConflictDoNothing({ target: [creditLedger.reason, creditLedger.ref] });
      return { balance: currentBalance };
    }

    const [ledgerRow] = await tx
      .insert(creditLedger)
      .values({ userId, deltaMinutes: applied, reason: JOB_RECONCILE_REASON, ref: jobId })
      .onConflictDoNothing({ target: [creditLedger.reason, creditLedger.ref] })
      .returning();

    if (!ledgerRow) {
      return { balance: currentBalance };
    }

    const [updated] = await tx
      .update(users)
      .set({ minutesBalance: sql`${users.minutesBalance} + ${applied}` })
      .where(eq(users.id, userId))
      .returning({ balance: users.minutesBalance });

    return { balance: updated?.balance ?? 0 };
  });
}

/** users.minutes_balance -- the cache. Should always equal ledgerSum(userId). */
export async function balance(userId: string): Promise<number> {
  const [row] = await db.select({ balance: users.minutesBalance }).from(users).where(eq(users.id, userId));
  return row?.balance ?? 0;
}

/** Sums every credit_ledger row for userId -- the truth `balance()` is cached from. Test-only assertion helper. */
export async function ledgerSum(userId: string): Promise<number> {
  const rows = await db.select({ delta: creditLedger.deltaMinutes }).from(creditLedger).where(eq(creditLedger.userId, userId));
  return Math.round(rows.reduce((sum, row) => sum + row.delta, 0));
}
