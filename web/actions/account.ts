"use server";

import { eq } from "drizzle-orm";
import { rm } from "node:fs/promises";
import path from "node:path";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { jobs, users } from "@/lib/db/schema";
import { storage } from "@/lib/storage";

// Mirrors actions/jobs.ts's WORK_ROOT convention -- pipeline scratch space
// keyed by jobId, outside lib/storage's STORAGE_ROOT.
const WORK_ROOT = path.join(process.cwd(), ".data", "work");

/**
 * Permanently deletes the SIGNED-IN caller's own account. userId always
 * comes from the session -- never a parameter, never client input -- so
 * this can never be pointed at another user's data (the cross-user-
 * isolation test in account.test.ts is the security core here).
 *
 * DB rows: every child table's FK onto users.id (jobs, credit_ledger,
 * payments, accounts, sessions) or transitively onto jobs.id/clips.id
 * (clips, agent_events) is declared `onDelete: "cascade"` in
 * lib/db/schema.ts. Deleting the users row is sufficient -- Postgres
 * cascades the rest inside that single DELETE statement. No manual
 * per-table deletes needed (confirmed against schema.ts; documented here
 * since this action is the one place that depends on it).
 *
 * Storage: purges the whole u/<userId> prefix via the W5 storage seam. No
 * trailing slash -- sanitizeKey treats a trailing "/" as an empty path
 * segment and rejects it (see storage.test.ts); `rm(..., {recursive:true})`
 * on the directory itself already removes the whole subtree. The prefix is
 * built from session.user.id, never client input, so it can't be steered
 * outside the caller's own tree -- resolveStoragePath's sanitizeKey still
 * rejects a stray '..' as defense in depth. LocalStorage.delete uses
 * `rm(..., { force: true })`, so a user with nothing uploaded yet no-ops
 * instead of throwing.
 *
 * Work dirs (pipeline scratch space, separate from the storage seam) are
 * cleaned up best-effort after everything else succeeds -- a missing dir
 * (job never reached the render stage, or was already cleaned up) must
 * not fail the account deletion.
 *
 * signOut always runs, even if storage.delete throws (W12 hardening): the
 * DB row is already gone by that point, so a deleted user must never keep
 * a valid session cookie just because a storage backend hiccupped. The
 * storage error still propagates to the caller (via `finally`) -- it's not
 * swallowed, just no longer allowed to block sign-out.
 */
export async function deleteAccount(): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("unauthorized");
  }

  // Capture job ids (for the best-effort work-dir cleanup below) and delete
  // the users row -- which cascades jobs/clips/agent_events/credit_ledger/
  // payments/accounts/sessions -- in one transaction, so the captured ids
  // can't drift from what actually got deleted.
  const userJobs = await db.transaction(async (tx) => {
    const rows = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
    return rows;
  });

  try {
    await storage.delete(`u/${userId}`);

    await Promise.all(
      userJobs.map((job) =>
        rm(path.join(WORK_ROOT, job.id), { recursive: true, force: true }).catch((err) => {
          console.error(`[deleteAccount] work dir cleanup failed for job ${job.id}:`, err);
        }),
      ),
    );
  } finally {
    // Runs even if storage.delete threw above -- the users row is already
    // deleted, so the session must not outlive it.
    await signOut({ redirectTo: "/" });
  }
}
