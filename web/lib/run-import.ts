import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentEvents, clips, jobs } from "@/lib/db/schema";
import { resolveStoragePath } from "@/lib/storage";
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
export async function importRun(jobId: string, outDir: string): Promise<void> {
  try {
    await doImport(jobId, outDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobs)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
  }
}

async function doImport(jobId: string, outDir: string): Promise<void> {
  const raw = await readFile(path.join(outDir, "run.json"), "utf8");

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

  const agentEventLines = await readAgentEvents(outDir);

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

  await db.transaction(async (tx) => {
    for (const clip of run.clips) {
      const row = await clipRow(userId, jobId, clip);
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
}

async function readAgentEvents(outDir: string) {
  let raw: string;
  try {
    raw = await readFile(path.join(outDir, "agent_events.jsonl"), "utf8");
  } catch {
    return []; // not every run produces one (e.g. a zero-clip run)
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

async function clipRow(userId: string, jobId: string, clip: ClipEntry) {
  const mp4Key = clip.paths.mp4
    ? await copyIntoStorage(clip.paths.mp4, `u/${userId}/${jobId}/clip_${clip.index}.mp4`)
    : null;
  const thumbKey = clip.paths.thumb
    ? await copyIntoStorage(
        clip.paths.thumb,
        `u/${userId}/${jobId}/clip_${clip.index}_thumb${path.extname(clip.paths.thumb) || ".jpg"}`,
      )
    : null;

  return {
    jobId,
    clipIndex: clip.index,
    tStart: clip.cut.t0,
    tEnd: clip.cut.t1,
    score: clip.score === null ? null : clip.score.total,
    hook: clip.hook === null ? null : clip.hook.title,
    captions: clip.hook === null ? null : clip.hook.captions,
    // The "why this clip" audit trail: score (full breakdown) + candidate
    // (the pre-cut window it came from), verbatim from run.json.
    evidence: { score: clip.score, candidate: clip.candidate },
    qa: clip.qa,
    r2Key: mp4Key,
    thumbKey,
    status: (clip.dropped_reason ? "dropped" : "ready") as "dropped" | "ready",
    droppedReason: clip.dropped_reason,
  };
}

/** Copies a worker-produced local file into the storage seam under `key`. */
async function copyIntoStorage(sourcePath: string, key: string): Promise<string> {
  const dest = resolveStoragePath(key);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(sourcePath, dest);
  return key;
}
