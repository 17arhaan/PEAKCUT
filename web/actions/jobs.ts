"use server";

import path from "node:path";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { assertOwnedKey } from "@/lib/storage";
import { worker } from "@/lib/worker";
import { debit, InsufficientCreditsError, refund } from "@/lib/credits";

export interface CreateJobInput {
  source: string;
  sourceType: "url" | "upload";
}

// Work dirs live outside lib/storage's STORAGE_ROOT (they're pipeline
// scratch space, not served back to the browser) but under the same
// gitignored .data/ tree.
const WORK_ROOT = path.join(process.cwd(), ".data", "work");

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
  const outDir = path.join(WORK_ROOT, jobId);

  try {
    await debit(userId, ESTIMATE_MINUTES, jobId);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      throw new Error(
        `Not enough minutes — you have ${err.available}, need ${err.required}.`,
      );
    }
    throw err;
  }

  await db.insert(jobs).values({
    id: jobId,
    userId,
    sourceType,
    sourceUrl: sourceType === "url" ? source : null,
    r2Key: sourceType === "upload" ? source : null,
    status: "queued",
  });

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
