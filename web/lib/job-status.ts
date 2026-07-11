import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentEvents, clips, jobs } from "@/lib/db/schema";
import { storage } from "@/lib/storage";

const EVENT_LIMIT = 20;

export interface JobStatusClip {
  index: number;
  status: "ready" | "dropped";
  score: number | null;
  hook: string | null;
  dropped_reason: string | null;
  mp4_url: string | null;
  thumb_url: string | null;
}

export interface JobStatusEvent {
  agent: string;
  action: string;
  payload: unknown;
  created_at: string;
}

export interface JobStatus {
  status: "queued" | "processing" | "done" | "failed";
  stage: string | null;
  progress: number;
  error: string | null;
  clips: JobStatusClip[];
  events: JobStatusEvent[];
}

/**
 * The status-route contract (spec §3 / W8 brief), queried straight from the
 * DB. Returns null when the job doesn't exist OR isn't owned by `userId` —
 * callers (the route handler, the server page) treat both identically as a
 * 404 so a non-owner can't distinguish "not found" from "not yours".
 *
 * Media URLs go through storage.getUrl (never a raw r2Key/thumbKey) and
 * only for ready clips — dropped clips carry null media so the client
 * can't be pointed at a file that was never rendered.
 */
export async function getJobStatusForOwner(jobId: string, userId: string): Promise<JobStatus | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job || job.userId !== userId) return null;

  const [clipRows, eventRows] = await Promise.all([
    db.select().from(clips).where(eq(clips.jobId, jobId)).orderBy(asc(clips.clipIndex)),
    db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.jobId, jobId))
      .orderBy(desc(agentEvents.createdAt))
      .limit(EVENT_LIMIT),
  ]);

  return {
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    clips: clipRows.map((clip) => ({
      index: clip.clipIndex,
      status: clip.status,
      score: clip.score,
      hook: clip.hook,
      dropped_reason: clip.droppedReason,
      mp4_url: clip.status === "ready" && clip.r2Key ? storage.getUrl(clip.r2Key) : null,
      thumb_url: clip.status === "ready" && clip.thumbKey ? storage.getUrl(clip.thumbKey) : null,
    })),
    // newest last, per the wire contract — reverse the DESC/LIMIT query.
    events: eventRows
      .slice()
      .reverse()
      .map((event) => ({
        agent: event.agent,
        action: event.action,
        payload: event.payload,
        created_at: event.createdAt.toISOString(),
      })),
  };
}
