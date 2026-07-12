"use server";

import path from "node:path";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { assertOwnedKey } from "@/lib/storage";
import { worker, type CaptionStyle } from "@/lib/worker";
import { debit, InsufficientCreditsError, refund } from "@/lib/credits";

export interface CreateJobInput {
  source: string;
  sourceType: "url" | "upload";
}

// Work dirs live outside lib/storage's STORAGE_ROOT (they're pipeline
// scratch space, not served back to the browser) but under the same
// gitignored .data/ tree.
const WORK_ROOT = path.join(process.cwd(), ".data", "work");

/**
 * The job's workdir isn't persisted on the jobs row -- it's derived
 * deterministically from jobId (same convention createJob has always used
 * for `outDir`), so reRenderStyle below can hand LocalWorker.renderStyle the
 * same directory createJob's LocalWorker.start originally wrote run.json
 * into, without a schema migration to store it.
 */
function jobWorkDir(jobId: string): string {
  return path.join(WORK_ROOT, jobId);
}

const CAPTION_STYLES: readonly CaptionStyle[] = ["s1", "s2", "s3"];

// The real minutes amount isn't knowable at job-creation time (video
// duration is discovered during ingest) -- reconcile() corrects the charge
// to actual usage once the job finishes (lib/run-import.ts).
// ponytail: flat URL estimate until duration known; same flat default for
// uploads (probing the file for its real duration is a v2 nicety).
const ESTIMATE_MINUTES = 30;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Creates a job row and kicks off the worker seam. Validates the source
 * (http(s) URL shape, or an upload key owned by the caller — real yt-dlp
 * URL validation happens in the Python ingest stage, not here) and auth,
 * then hands off to `worker.start`, which returns once the pipeline is
 * spawned (or stubbed) — this action does not wait for the job to finish.
 */
export async function createJob(input: CreateJobInput): Promise<{ jobId: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("unauthorized");
  }

  const { source, sourceType } = input;

  if (sourceType === "url") {
    if (!isHttpUrl(source)) {
      throw new Error("source must be a valid http(s) URL");
    }
  } else if (sourceType === "upload") {
    // Reuses the storage seam's ownership check — no new traversal surface;
    // the client-supplied key is never trusted on its own.
    try {
      assertOwnedKey(source, userId);
    } catch (err) {
      throw new Error((err as Error).message);
    }
  } else {
    throw new Error("invalid sourceType");
  }

  const jobId = crypto.randomUUID();
  const outDir = jobWorkDir(jobId);

  // Debit and job-row insert MUST commit or roll back together: if the
  // insert fails (PK collision, transient DB error) after a standalone
  // debit had already committed, the charge would be stranded -- balance
  // down, no job row to hang a refund off. One transaction closes that gap.
  try {
    await db.transaction(async (tx) => {
      await debit(userId, ESTIMATE_MINUTES, jobId, tx);
      await tx.insert(jobs).values({
        id: jobId,
        userId,
        sourceType,
        sourceUrl: sourceType === "url" ? source : null,
        r2Key: sourceType === "upload" ? source : null,
        status: "queued",
      });
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      throw new Error(
        `Not enough minutes — you have ${err.available}, need ${err.required}.`,
      );
    }
    throw err;
  }

  try {
    await worker.start({ id: jobId, source, outDir });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "unknown worker error";
    await db
      .update(jobs)
      .set({ status: "failed", error: errorMsg, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
    // The job never actually ran -- give the estimate back rather than
    // stranding it debited against a job that failed before it started.
    await refund(userId, jobId, ESTIMATE_MINUTES).catch((refundErr) => {
      console.error(`[job ${jobId}] refund-on-start-failure error:`, refundErr);
    });
    throw err;
  }

  return { jobId };
}

/**
 * W11 caption-style switcher: re-renders a finished job's clips in a
 * different karaoke caption preset without re-running ingest/signals/crew --
 * `worker.renderStyle` reuses the persisted signals/cuts already on disk at
 * the job's workdir. Guarded to owner + `status === 'done'` jobs only (a
 * queued/processing job has no run.json to re-render from yet; a failed job
 * has none either). Not-found and not-owned collapse to the same error, same
 * pattern as getJobStatusForOwner (lib/job-status.ts) -- a non-owner can't
 * distinguish "doesn't exist" from "isn't yours".
 *
 * CONCURRENCY: The status==='done' check and the UPDATE are atomic (single
 * compare-and-swap via UPDATE ... WHERE status='done' RETURNING). If the
 * returning array is empty, the job wasn't 'done' (already restyling, or
 * not owner, or gone) → return the appropriate error WITHOUT spawning the
 * worker. Only call worker.renderStyle when the CAS actually flipped the row.
 *
 * ponytail: restyle is free -- no crew/whisper cost, just a fast re-render
 * of already-scored clips. No debit/refund here (unlike createJob). Revisit
 * if render compute ever needs metering.
 */
export async function reRenderStyle(jobId: string, style: string): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("unauthorized");
  }

  if (!CAPTION_STYLES.includes(style as CaptionStyle)) {
    throw new Error(`invalid style: ${style}`);
  }

  // Pre-check: job exists and is owned by the caller. This allows us to give
  // a better error message than "not done" if the job doesn't exist or isn't
  // owned (collapsing not-found and not-owned to the same message, same as
  // getJobStatusForOwner). The ownership check here is a guard; the atomicity
  // check below (UPDATE ... WHERE status='done') is the concurrency guard.
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job || job.userId !== userId) {
    throw new Error("job not found");
  }

  // Atomic compare-and-swap: update status to processing IF currently done.
  // If the update returns no rows, the job wasn't 'done' (already restyling
  // from another request, or status changed since the pre-check above).
  const [updated] = await db
    .update(jobs)
    .set({ status: "processing", stage: "restyle", progress: 0, updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "done")))
    .returning();

  if (!updated) {
    throw new Error("only a completed job can be restyled");
  }

  try {
    await worker.renderStyle({ id: jobId, workdir: jobWorkDir(jobId), style: style as CaptionStyle });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "unknown worker error";
    await db
      .update(jobs)
      .set({ status: "failed", error: errorMsg, updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
    throw err;
  }
}
