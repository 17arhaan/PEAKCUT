import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { importRun } from "@/lib/run-import";
import { AGENT_STAGE, markFailed, refundOnCrash, setJobStage } from "@/lib/worker";

export const runtime = "nodejs";

// The Modal worker's return path (ModalWorker's counterpart). Three payload
// shapes, all authenticated with WORKER_SHARED_SECRET:
//   progress  -- an agent name; advances jobs.stage/progress mid-run
//   done      -- the full run.json (+ agent_events.jsonl text); clips are
//                ALREADY uploaded to storage under the conventional keys, so
//                the import runs entirely from this request body
//                (preuploaded + content -- no filesystem involved)
//   error     -- marks the job failed + refunds the estimate
const ProgressSchema = z.object({
  type: z.literal("progress"),
  job_id: z.string().min(1),
  agent: z.string().min(1),
});
const DoneSchema = z.object({
  type: z.literal("done"),
  job_id: z.string().min(1),
  run_json: z.string().min(1),
  agent_events_jsonl: z.string().optional(),
});
const ErrorSchema = z.object({
  type: z.literal("error"),
  job_id: z.string().min(1),
  error: z.string().min(1),
});
const PayloadSchema = z.discriminatedUnion("type", [ProgressSchema, DoneSchema, ErrorSchema]);

function authorized(request: Request): boolean {
  const secret = env.WORKER_SHARED_SECRET;
  if (!secret) return false; // fail closed, same policy as CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  const payload = parsed.data;

  if (payload.type === "progress") {
    const stage = AGENT_STAGE[payload.agent];
    if (stage) {
      await setJobStage(payload.job_id, stage);
    }
    return NextResponse.json({ ok: true });
  }

  if (payload.type === "error") {
    console.error(`[job ${payload.job_id}] modal worker reported failure:`, payload.error);
    await markFailed(payload.job_id, payload.error);
    await refundOnCrash(payload.job_id);
    return NextResponse.json({ ok: true });
  }

  // done: the real importer (schema validation, cost/credits reconcile, clip
  // rows) runs straight off the request body against preuploaded storage
  // keys. importRun never throws -- failures land on the job row.
  await importRun(payload.job_id, "", {
    preuploaded: true,
    content: {
      runJson: payload.run_json,
      agentEventsJsonl: payload.agent_events_jsonl,
    },
  });
  return NextResponse.json({ ok: true });
}
