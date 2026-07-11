"use server";

import path from "node:path";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { assertOwnedKey } from "@/lib/storage";
import { worker } from "@/lib/worker";

export interface CreateJobInput {
  source: string;
  sourceType: "url" | "upload";
}

// Work dirs live outside lib/storage's STORAGE_ROOT (they're pipeline
// scratch space, not served back to the browser) but under the same
// gitignored .data/ tree.
const WORK_ROOT = path.join(process.cwd(), ".data", "work");

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// W9 implements atomic debit: deducts minutes from users.minutesBalance via
// a credit_ledger row (idempotent insert+update, same pattern as auth.ts's
// signup-grant), rejecting when balance is insufficient. The real minutes
// amount isn't knowable at job-creation time anyway (video duration is
// discovered during ingest) — that reservation/settlement design is W9's,
// not this seam's. Stubbed as an always-ok no-op so createJob's flow
// completes end to end.
async function debitCredits(_userId: string, _minutes: number): Promise<{ ok: boolean }> {
  return { ok: true };
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

  const debit = await debitCredits(userId, 0);
  if (!debit.ok) {
    throw new Error("insufficient credits");
  }

  const jobId = crypto.randomUUID();
  const outDir = path.join(WORK_ROOT, jobId);

  await db.insert(jobs).values({
    id: jobId,
    userId,
    sourceType,
    sourceUrl: sourceType === "url" ? source : null,
    r2Key: sourceType === "upload" ? source : null,
    status: "queued",
  });

  await worker.start({ id: jobId, source, outDir });

  return { jobId };
}
