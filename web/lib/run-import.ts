import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentEvents, clips, jobs } from "@/lib/db/schema";
import { estimatedMinutesFor, reconcile, refund } from "@/lib/credits";
import { storage } from "@/lib/storage";
import { AgentEventSchema, RunErrorSchema, RunJsonSchema, type ClipEntry } from "@/lib/types";

/**
 * The worker->web data bridge: turns a completed pipeline run's run.json
 * (+ agent_events.jsonl) into `jobs`/`clips`/`agent_events` rows. Mapping
 * rules are LAW (plan's Global Constraints):
 *   - t_start/t_end <- cut.t0/t1 (NOT candidate)
 *   - duration_min <- duration_processed_s/60 (NOT source.duration_s)
 *   - clip status: dropped_reason set -> 'dropped', else 'ready'
 *   - score/hook/qa may be null -- handled null-safe throughout
 *   - cost_cents <- sum(agent_totals.*.cost_cents)
 *
 * Never throws: every failure path (bad JSON, schema mismatch, version
 * mismatch, the worker's own `{error}` shape, a missing source file for the
 * storage copy) is caught and persisted as `jobs.status = 'failed'` +
 * `jobs.error`, so LocalWorker's `child.on("exit", ...)` handler never sees
 * a rejected promise and clobbers this function's specific error message
 * with its own generic stderr-tail fallback.
 */
export async function importRun(
  jobId: string,
  outDir: string,
  opts: ImportOptions = {},
): Promise<void> {
  try {
    await doImport(jobId, outDir, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobs)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
    // Auto-refund on failure (spec §7): every branch that lands here (bad
    // JSON, schema mismatch, the worker's own {error} shape, a missing
    // source file for the storage copy, a failed tx) means the job never
    // produced billable output -- give the full estimate back. Best-effort:
    // a refund failure must not turn into an uncaught throw out of
    // importRun (its contract is "never throws"), and it must not clobber
    // the failed-status write above.
    try {
      const [jobRow] = await db.select({ userId: jobs.userId }).from(jobs).where(eq(jobs.id, jobId));
      if (jobRow) {
        const estimate = await estimatedMinutesFor(jobRow.userId, jobId);
        if (estimate > 0) {
          await refund(jobRow.userId, jobId, estimate);
        }
      }
    } catch (refundErr) {
      console.error(`[job ${jobId}] refund-on-failure error:`, refundErr);
    }
  }
}

export interface ImportOptions {
  /** The worker already uploaded every clip's media to storage under the
   * conventional keys (u/<userId>/<jobId>/clip_<n>.mp4) -- ModalWorker's
   * callback path. Skip the local-file copy AND the cleanup-on-failure
   * (deleting a remote worker's uploads on a tx hiccup would destroy user
   * output that a retried import could still use). */
  preuploaded?: boolean;
  /** In-memory artifacts (the Modal callback's request body) -- when set,
   * nothing is read from `outDir` at all, which also keeps this path off the
   * filesystem entirely on serverless. */
  content?: { runJson: string; agentEventsJsonl?: string };
}

async function doImport(jobId: string, outDir: string, opts: ImportOptions = {}): Promise<void> {
  const raw = opts.content ? opts.content.runJson : await readFile(path.join(outDir, "run.json"), "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`run.json is not valid JSON: ${(err as Error).message}`);
  }

  // Checked explicitly (not just via the schemas' `z.literal(1)`) so a
  // version mismatch produces a specific, loud message instead of a generic
  // zod issue list.
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== 1) {
    throw new Error(`run.json version mismatch: expected 1, got ${JSON.stringify(version)}`);
  }

  if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
    const result = RunErrorSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`run.json error-shape failed validation: ${result.error.message}`);
    }
    throw new Error(result.data.error.message);
  }

  const result = RunJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`run.json failed schema validation: ${result.error.message}`);
  }
  const run = result.data;

  const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!jobRow) {
    throw new Error(`job ${jobId} not found`);
  }
  const userId = jobRow.userId;

  const agentEventLines = opts.content
    ? parseAgentEventLines(opts.content.agentEventsJsonl ?? "")
    : await readAgentEvents(outDir);

  // cost_cents <- sum(agent_totals.*.cost_cents). agent_totals only ever
  // carries LLM-agent entries (scout/critic/orchestrator/surgeon/hooks/qa
  // via AgentLog.emit) -- non-LLM stages (ingest/signals/render) cost
  // nothing and never appear here, so summing every key is correct as-is.
  // ponytail: LLM-only cost accounting -- add compute/storage cost lines
  // here if a non-LLM stage ever needs to bill.
  const costCents = Math.round(
    Object.values(run.agent_totals).reduce((sum, t) => sum + t.cost_cents, 0),
  );
  const durationMin = run.duration_processed_s === null ? null : run.duration_processed_s / 60;

  // Copy every clip's render/thumb into storage BEFORE opening the DB
  // transaction, not inside it: a copy is file I/O today (LocalStorage) but
  // will be a network call once R2Storage lands, and a tx must never sit
  // open across network I/O. Doing all copies up front also means a missing
  // source file aborts the whole import before any DB row is written --
  // no tx to roll back, no partial clip rows.
  const copiedKeys: { mp4Key: string | null; thumbKey: string | null }[] = [];
  if (opts.preuploaded) {
    // Media already in storage under the conventional keys (uploaded by the
    // remote worker before it called back) -- just derive them.
    for (const clip of run.clips) {
      copiedKeys.push({
        mp4Key: clip.paths.mp4 ? `u/${userId}/${jobId}/clip_${clip.index}.mp4` : null,
        thumbKey: clip.paths.thumb ? `u/${userId}/${jobId}/clip_${clip.index}_thumb.jpg` : null,
      });
    }
  } else {
    try {
      for (const clip of run.clips) {
        copiedKeys.push(await copyClipFiles(userId, jobId, clip));
      }
    } catch (err) {
      await cleanupCopiedKeys(copiedKeys);
      throw err;
    }
  }

  try {
    await db.transaction(async (tx) => {
      for (const [i, clip] of run.clips.entries()) {
        const row = clipRow(jobId, clip, copiedKeys[i]);
        await tx
          .insert(clips)
          .values(row)
          .onConflictDoUpdate({ target: [clips.jobId, clips.clipIndex], set: row });
      }

      // No natural unique key per agent_events.jsonl line (identical lines
      // are legitimate), so idempotent replay is delete-then-insert rather
      // than upsert.
      await tx.delete(agentEvents).where(eq(agentEvents.jobId, jobId));
      if (agentEventLines.length > 0) {
        await tx.insert(agentEvents).values(
          agentEventLines.map((e) => ({
            jobId,
            agent: e.agent,
            action: e.action,
            payload: e.payload,
            tokensIn: e.tokens_in,
            tokensOut: e.tokens_out,
          })),
        );
      }

      // status='done' flipped LAST so a polling client never observes 'done'
      // with partial clip rows.
      await tx
        .update(jobs)
        .set({
          costCents,
          durationMin,
          status: "done",
          stage: "render",
          progress: 1,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
    });
  } catch (err) {
    // tx rolled back its own DB writes; the already-copied files are not
    // part of that transaction, so clean them up ourselves (never for
    // preuploaded media -- see ImportOptions).
    if (!opts.preuploaded) {
      await cleanupCopiedKeys(copiedKeys);
    }
    throw err;
  }

  // Job succeeded (status is already 'done' as of the tx above) -- correct
  // its charge from the job-creation estimate to actual usage. Dropped-only
  // runs (every clip dropped) still land here and still reconcile to
  // actual, not a full refund: the pipeline did the compute regardless of
  // how many clips survived QA. Deliberately outside the tx above and its
  // own try/catch: a reconcile failure is a credits-side problem, not an
  // import problem, and must never retroactively flip an already-committed
  // 'done' job back to 'failed'.
  try {
    // durationMin null (duration_processed_s missing) reconciles to 0 --
    // deliberate policy: a done job with no measured usage is refunded in
    // full rather than charged the estimate for unmeasured work.
    await reconcile(userId, jobId, durationMin ?? 0);
  } catch (err) {
    console.error(`[job ${jobId}] reconcile error:`, err);
  }
}

/**
 * W11 caption-style switcher's sibling to importRun: reads run-<style>.json
 * (written by `shorts render --from <workdir> --style <style>`, which
 * reuses the original run's persisted signals/cuts -- no re-transcription
 * or crew) and swaps ONLY the existing clip rows' media keys
 * (r2Key/thumbKey) to the freshly rendered files. Never inserts or deletes
 * clip rows, and never writes score/hook/captions/evidence/qa/status even
 * though run-<style>.json's clip entries carry those fields too (same
 * RunJsonSchema shape as a full run) -- a restyle changes how a clip is
 * captioned, not its score or its survival. No credit reconcile/refund
 * here, unlike importRun -- restyle is free (ponytail: revisit if render
 * compute matters). Same never-throws contract as importRun: every failure
 * path lands as jobs.status='failed'/jobs.error, caught by LocalWorker's
 * renderStyle exit handler.
 */
export async function importStyleRun(jobId: string, workdir: string, style: string): Promise<void> {
  try {
    await doImportStyle(jobId, workdir, style);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobs)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
  }
}

async function doImportStyle(jobId: string, workdir: string, style: string): Promise<void> {
  const raw = await readFile(path.join(workdir, `run-${style}.json`), "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`run-${style}.json is not valid JSON: ${(err as Error).message}`);
  }

  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== 1) {
    throw new Error(`run-${style}.json version mismatch: expected 1, got ${JSON.stringify(version)}`);
  }

  if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
    const result = RunErrorSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`run-${style}.json error-shape failed validation: ${result.error.message}`);
    }
    throw new Error(result.data.error.message);
  }

  const result = RunJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`run-${style}.json failed schema validation: ${result.error.message}`);
  }
  const run = result.data;

  const [jobRow] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!jobRow) {
    throw new Error(`job ${jobId} not found`);
  }
  const userId = jobRow.userId;

  // Restyle describes the SAME clips (reused signals/cuts) -- only entries
  // that already have a row survive. Anything in run-<style>.json that
  // doesn't match an existing (jobId, clipIndex) row is ignored rather than
  // inserted, guarding the "restyle never changes clip count" invariant.
  const existingRows = await db.select({ clipIndex: clips.clipIndex }).from(clips).where(eq(clips.jobId, jobId));
  const existingIndexes = new Set(existingRows.map((c) => c.clipIndex));

  const updates: { clipIndex: number; mp4Key: string | null; thumbKey: string | null }[] = [];
  const copiedKeys: { mp4Key: string | null; thumbKey: string | null }[] = [];
  try {
    for (const clip of run.clips) {
      if (!existingIndexes.has(clip.index)) continue;
      const keys = await copyStyleClipFiles(userId, jobId, style, clip);
      copiedKeys.push(keys);
      updates.push({ clipIndex: clip.index, ...keys });
    }
  } catch (err) {
    await cleanupCopiedKeys(copiedKeys);
    throw err;
  }

  try {
    await db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(clips)
          .set({ r2Key: u.mp4Key, thumbKey: u.thumbKey })
          .where(and(eq(clips.jobId, jobId), eq(clips.clipIndex, u.clipIndex)));
      }

      // status='done' flipped LAST, same reasoning as doImport: a polling
      // client never observes 'done' with a partially-swapped clip grid.
      await tx
        .update(jobs)
        .set({
          activeStyle: style as "s1" | "s2" | "s3",
          status: "done",
          stage: "render",
          progress: 1,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
    });
  } catch (err) {
    await cleanupCopiedKeys(copiedKeys);
    throw err;
  }
}

/**
 * Copies a clip's restyled render + thumb into storage, re-keyed with the
 * style suffix (u/<userId>/<jobId>/clip_<i>_<style>.mp4) so a later restyle
 * to a different style doesn't collide with this one's files. ponytail: a
 * prior style's now-orphaned clip_<i>_<otherStyle>.mp4 is not garbage
 * collected -- acceptable v1 disk cost; add cleanup if storage pressure
 * ever matters.
 */
async function copyStyleClipFiles(
  userId: string,
  jobId: string,
  style: string,
  clip: ClipEntry,
): Promise<{ mp4Key: string | null; thumbKey: string | null }> {
  const mp4Key = clip.paths.mp4
    ? await copyIntoStorage(clip.paths.mp4, `u/${userId}/${jobId}/clip_${clip.index}_${style}.mp4`)
    : null;
  const thumbKey = clip.paths.thumb
    ? await copyIntoStorage(
        clip.paths.thumb,
        `u/${userId}/${jobId}/clip_${clip.index}_${style}_thumb${path.extname(clip.paths.thumb) || ".jpg"}`,
      )
    : null;
  return { mp4Key, thumbKey };
}

function parseAgentEventLines(raw: string) {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

async function readAgentEvents(outDir: string) {
  let raw: string;
  try {
    raw = await readFile(path.join(outDir, "agent_events.jsonl"), "utf8");
  } catch {
    return []; // not every run produces one (e.g. a zero-clip run)
  }
  return parseAgentEventLines(raw);
}

/** Copies a clip's render + thumb into storage. Called before the DB tx opens (see doImport). */
async function copyClipFiles(
  userId: string,
  jobId: string,
  clip: ClipEntry,
): Promise<{ mp4Key: string | null; thumbKey: string | null }> {
  const mp4Key = clip.paths.mp4
    ? await copyIntoStorage(clip.paths.mp4, `u/${userId}/${jobId}/clip_${clip.index}.mp4`)
    : null;
  const thumbKey = clip.paths.thumb
    ? await copyIntoStorage(
        clip.paths.thumb,
        `u/${userId}/${jobId}/clip_${clip.index}_thumb${path.extname(clip.paths.thumb) || ".jpg"}`,
      )
    : null;
  return { mp4Key, thumbKey };
}

/** Best-effort cleanup of already-copied files when a later clip's copy, or the tx, fails. */
async function cleanupCopiedKeys(copiedKeys: { mp4Key: string | null; thumbKey: string | null }[]) {
  const keys = copiedKeys.flatMap((k) => [k.mp4Key, k.thumbKey]).filter((k): k is string => k !== null);
  await Promise.all(keys.map((key) => storage.delete(key).catch(() => {})));
}

function clipRow(jobId: string, clip: ClipEntry, keys: { mp4Key: string | null; thumbKey: string | null }) {
  return {
    jobId,
    clipIndex: clip.index,
    tStart: clip.cut.t0,
    tEnd: clip.cut.t1,
    score: clip.score === null ? null : clip.score.total,
    hook: clip.hook === null ? null : clip.hook.title,
    captions: clip.hook === null ? null : clip.hook.captions,
    // The "why this clip" audit trail: score (full breakdown) + candidate
    // (the pre-cut window it came from) + repairs (what QA/surgeon did to
    // it), verbatim from run.json.
    evidence: { score: clip.score, candidate: clip.candidate, repairs: clip.repairs },
    qa: clip.qa,
    r2Key: keys.mp4Key,
    thumbKey: keys.thumbKey,
    status: (clip.dropped_reason ? "dropped" : "ready") as "dropped" | "ready",
    droppedReason: clip.dropped_reason,
  };
}

/** Copies a worker-produced local file into the storage seam under `key`
 * (local disk in dev, an R2 PutObject when R2 is configured). */
async function copyIntoStorage(sourcePath: string, key: string): Promise<string> {
  await storage.putObjectFromFile(key, sourcePath);
  return key;
}
