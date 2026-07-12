/**
 * Pure formatters/humanizers for the "why this clip" evidence panel (W10).
 * Turns the evidence/qa jsonb blobs W7 stored verbatim from run.json
 * (lib/run-import.ts's clipRow — `evidence: { score, candidate, repairs }`,
 * `qa`) into copy a user can read. No React here: ClipEvidence.tsx is the
 * only place this data touches JSX, so every branch here is unit-testable
 * without rendering anything.
 *
 * Types mirror the worker's run.json contract (lib/types.ts's zod schemas,
 * itself a mirror of worker/src/shorts/types.py) — kept as plain interfaces
 * here since this module has nothing to validate, only to already-trusted
 * data (W7 wrote it through RunJsonSchema on the way in).
 */

export interface Claim {
  kind: string;
  t: number;
  value?: number | string | null;
}

export interface ScoreComponent {
  score: number;
  evidence: Claim[];
}

export interface Score {
  total: number;
  verdict: string;
  components: Record<string, ScoreComponent>;
}

export interface Candidate {
  t0: number;
  t1: number;
  source: string;
  notes: string;
  evidence: Claim[];
}

// repairs entries come off the wire as z.record(z.string(), z.unknown()) —
// no guaranteed field types — so every accessor in humanizeRepair() below
// checks its type before using it.
export type Repair = Record<string, unknown>;

export interface ClipEvidence {
  score: Score | null;
  candidate: Candidate;
  repairs: Repair[];
}

export interface QaFailure {
  code: string;
  detail: string;
}

export interface Qa {
  passed: boolean;
  failures: QaFailure[];
}

const QUOTE_MAX_CHARS = 60;

/** Seconds -> "m:ss". Negative/NaN input clamps to "0:00" rather than crashing or printing garbage. */
export function formatSeconds(s: number): string {
  const total = Number.isFinite(s) ? Math.max(0, Math.round(s)) : 0;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A single evidence Claim -> a human-readable line. `value`'s type varies
 * per `kind` (number, string, or absent/null) — every branch below is
 * null/type-safe so a claim from an unexpected kind, or a wrong-typed
 * value, degrades to a plain "at {time}" line instead of throwing.
 */
export function formatClaim(claim: Claim): string {
  const { kind, t, value } = claim;
  const at = formatSeconds(t);

  switch (kind) {
    case "energy_peak":
      return typeof value === "number" ? `Energy spike +${value}σ at ${at}` : `Energy spike at ${at}`;
    case "laughter":
      return `Laughter at ${at}`;
    case "applause":
      return `Applause at ${at}`;
    case "rate_surge":
      return `Faster speech at ${at}`;
    case "silence":
      return `Natural pause at ${at}`;
    case "scene_stable":
      return `Stable shot at ${at}`;
    case "quote":
      return typeof value === "string"
        ? `Quotable: "${truncate(value, QUOTE_MAX_CHARS)}"`
        : `Quotable moment at ${at}`;
    default:
      return `${kind} at ${at}`;
  }
}

const COMPONENT_LABELS: Record<string, string> = {
  hook_strength: "Hook strength",
  payoff: "Payoff",
  emotion: "Emotion",
  quotability: "Quotability",
};

/** Score-component key -> display name. Unknown keys title-case their snake_case form rather than showing raw. */
export function humanizeComponent(name: string): string {
  if (COMPONENT_LABELS[name]) return COMPONENT_LABELS[name];
  const spaced = name.replace(/_/g, " ");
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const SOURCE_LABELS: Record<string, string> = {
  rule_a_energy_rate: "Found by: energy + speech-rate rule",
  llm: "Found by: AI semantic pass",
  fallback: "Padding (low-signal content)",
};

/** candidate.source -> why-it-was-picked copy. Unknown sources still say "Found by: <source>" rather than nothing. */
export function humanizeSource(source: string): string {
  return SOURCE_LABELS[source] ?? `Found by: ${source}`;
}

const ROUTE_LABELS: Record<string, string> = {
  surgeon: "re-cut",
  render: "re-render",
};

/**
 * One repairs[] entry -> a timeline line, e.g. "Attempt 1: fixed ALIGN via
 * re-cut". Every field is read defensively (repairs is an untyped jsonb
 * record on the wire) so a malformed/partial entry still renders something
 * sane instead of crashing the dialog.
 */
export function humanizeRepair(repair: Repair): string {
  const attempt = typeof repair.attempt === "number" ? repair.attempt : "?";
  const codes = Array.isArray(repair.codes)
    ? repair.codes.filter((c): c is string => typeof c === "string")
    : [];
  const route = typeof repair.route === "string" ? (ROUTE_LABELS[repair.route] ?? repair.route) : "unknown step";
  const outcome = repair.outcome === "fixed" ? "fixed" : "attempted to fix";
  const codeList = codes.length > 0 ? codes.join(", ") : "an issue";
  return `Attempt ${attempt}: ${outcome} ${codeList} via ${route}`;
}

const QA_CODE_LABELS: Record<string, string> = {
  RES: "Wrong resolution",
  LUFS: "Audio loudness off-target",
  BLACK: "Black frame detected",
  FROZEN: "Frozen frame detected",
  WORD_CLIP: "Clipped word at the cut",
  ALIGN: "Caption alignment issue",
  DUR: "Clip duration out of range",
  SAFE_AREA: "Caption overflowed safe area",
};

/** worker/src/shorts/qa.py failure code -> display label. Unknown codes fall back to the raw code (short enum text, not a jsonb dump). */
export function humanizeQaCode(code: string): string {
  return QA_CODE_LABELS[code] ?? code;
}
