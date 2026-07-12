import { NextResponse } from "next/server";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { estimatedMinutesFor, refund } from "@/lib/credits";

export const runtime = "nodejs";

// Two failure modes this sweeps up (plan Task 14 + W9's deferred stranded
// case): a job whose worker died silently (no exit handler ever fired, e.g.
// this Next.js process itself restarted mid-run) sits at
// queued/processing forever; a job whose worker exited but produced no
// run.json (W9) is *supposed* to be caught by LocalWorker's own
// exit-handler markFailed -- this is the backstop for the case where even
// that never ran.
const STALE_MS = 30 * 60 * 1000;
const AUTH_HEADER = "authorization";

function isAuthorized(request: Request): boolean {
  // Unset secret is a deploy misconfiguration, not "no auth required" --
  // fail closed (401), same policy as the billing webhook route.
  if (!env.CRON_SECRET) return false;
  return request.headers.get(AUTH_HEADER) === `Bearer ${env.CRON_SECRET}`;
}

/**
 * Vercel-cron-shaped stuck-job sweeper (plan Task 14). Finds every
 * queued/processing job whose `updatedAt` hasn't moved in STALE_MS, marks it
 * failed, and refunds its debited estimate. Idempotent per job: the refund
 * (lib/credits.ts) is keyed on (reason='job_refund', ref=jobId) so a job
 * already refunded by this route -- or by importRun's own failure path --
 * is never double-refunded, and a job's status-CAS'd UPDATE only fires for
 * jobs still in queued/processing at the moment of the write, so a repeat
 * cron run naturally finds nothing left to sweep for it (the first run's
 * initial SELECT already excludes anything not in that status set).
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - STALE_MS);
  const candidates = await db
    .select({ id: jobs.id, userId: jobs.userId })
    .from(jobs)
    .where(and(inArray(jobs.status, ["queued", "processing"]), lt(jobs.updatedAt, cutoff)));

  let swept = 0;
  for (const job of candidates) {
    try {
      // Atomic CAS: only flip (and only refund) if the job is STILL
      // queued/processing at write time -- guards against a race with the
      // worker finishing between the SELECT above and this UPDATE.
      const [updated] = await db
        .update(jobs)
        .set({ status: "failed", error: "timed out", updatedAt: new Date() })
        .where(and(eq(jobs.id, job.id), inArray(jobs.status, ["queued", "processing"])))
        .returning();
      if (!updated) continue;

      const estimate = await estimatedMinutesFor(job.userId, job.id);
      if (estimate > 0) {
        await refund(job.userId, job.id, estimate);
      }
      swept++;
    } catch (err) {
      // One job's sweep failing (e.g. a transient DB error on the refund)
      // must not abort the whole sweep -- log and keep going.
      console.error(`[sweep] job ${job.id} sweep error:`, err);
    }
  }

  return NextResponse.json({ swept });
}
