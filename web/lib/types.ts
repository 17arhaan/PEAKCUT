import { z } from "zod";

/**
 * Zod mirror of the FROZEN run.json contract (worker/src/shorts/pipeline.py's
 * `_clip_entry` + `run()`'s tail, `_write_run_json`). This is the only place
 * the web app should assume anything about the worker's on-disk output
 * shape — lib/run-import.ts parses through these schemas, never `as`-casts
 * raw JSON.
 */

// Claim.value: float | str | None (worker/src/shorts/types.py) -- always
// present as a key (pipeline.py's _claim_json always sets "value": cl.value)
// but the value itself may be null.
const ClaimSchema = z.object({
  kind: z.string(),
  t: z.number(),
  value: z.union([z.number(), z.string(), z.null()]).optional(),
});

const CandidateSchema = z.object({
  t0: z.number(),
  t1: z.number(),
  source: z.string(),
  notes: z.string(),
  evidence: z.array(ClaimSchema),
});

const CutSchema = z.object({
  t0: z.number(),
  t1: z.number(),
  payoff_word_i: z.number().nullable(),
});

const ScoreComponentSchema = z.object({
  score: z.number(),
  evidence: z.array(ClaimSchema),
});

const ScoreSchema = z.object({
  total: z.number(),
  verdict: z.string(),
  components: z.record(z.string(), ScoreComponentSchema),
});

const HookSchema = z.object({
  title: z.string(),
  captions: z.record(z.string(), z.string()),
});

const QAFailSchema = z.object({
  code: z.string(),
  detail: z.string(),
});

const QASchema = z.object({
  passed: z.boolean(),
  failures: z.array(QAFailSchema),
});

const PathsSchema = z.object({
  mp4: z.string().nullable(),
  thumb: z.string().nullable(),
});

const ClipEntrySchema = z.object({
  index: z.number(),
  candidate: CandidateSchema,
  cut: CutSchema,
  // A clip dropped before scoring/hooking/QA (e.g. an ingest-stage kill)
  // carries null here -- every consumer must be null-safe.
  score: ScoreSchema.nullable(),
  hook: HookSchema.nullable(),
  qa: QASchema.nullable(),
  repairs: z.array(z.record(z.string(), z.unknown())),
  dropped_reason: z.string().nullable(),
  paths: PathsSchema,
});

const SourceSchema = z.object({
  input: z.string(),
  duration_s: z.number().nullable(),
  fps: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});

const AgentTotalSchema = z.object({
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_cents: z.number(),
});

// RUN_SCHEMA_VERSION in pipeline.py is currently 1. Both the success and
// error shapes pin `version: 1` as a literal -- any other value fails zod
// validation, which lib/run-import.ts surfaces as a loud, specific job
// failure rather than silently misreading a future/older contract.
export const RunJsonSchema = z.object({
  version: z.literal(1),
  pipeline_version: z.string(),
  source: SourceSchema,
  duration_processed_s: z.number().nullable(),
  agent_totals: z.record(z.string(), AgentTotalSchema),
  timings_s: z.record(z.string(), z.number()),
  clips: z.array(ClipEntrySchema),
});
export type RunJson = z.infer<typeof RunJsonSchema>;
export type ClipEntry = z.infer<typeof ClipEntrySchema>;

// Written instead of the success shape when ingest.resolve() raises an
// IngestError (pipeline.py's `run()`, the early-return branch).
export const RunErrorSchema = z.object({
  version: z.literal(1),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type RunError = z.infer<typeof RunErrorSchema>;

// worker/src/shorts/agent_log.py's AgentLog.emit() record shape, one per
// line of agent_events.jsonl.
export const AgentEventSchema = z.object({
  agent: z.string(),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()),
  tokens_in: z.number().default(0),
  tokens_out: z.number().default(0),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;
