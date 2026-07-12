/**
 * Pure humanizers for the job-live view (JobLive.tsx) — turn a job's
 * `stage` column and raw agent_events rows into copy a user can read.
 * Kept dependency-free and side-effect-free so they're trivially unit
 * tested and reusable from both the server page (initial render) and the
 * client poller.
 */

const STAGE_LABELS: Record<string, string> = {
  ingest: "Downloading",
  signals: "Analyzing audio & video",
  crew: "Finding the best moments",
  render: "Rendering clips",
  restyle: "Applying new caption style",
};

function titleCase(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function humanizeStage(stage: string | null): string {
  if (!stage) return "Getting started";
  return STAGE_LABELS[stage] ?? titleCase(stage);
}

/** Extracts a numeric `count` field from an agent_events payload, if present. */
function extractCount(payload: unknown): number | null {
  if (payload !== null && typeof payload === "object" && "count" in payload) {
    const count = (payload as { count: unknown }).count;
    return typeof count === "number" ? count : null;
  }
  return null;
}

/**
 * agent/action -> a short activity-feed line. Defensive against agents and
 * actions the worker hasn't emitted yet (or ever will) — an unrecognized
 * agent falls back to its titlecased name rather than throwing or showing
 * raw identifiers.
 */
export function humanizeEvent(agent: string, action: string, payload: unknown): string {
  switch (agent) {
    case "scout": {
      const count = extractCount(payload);
      if (action === "found" && count !== null) {
        return `Scout found ${count} moment${count === 1 ? "" : "s"}`;
      }
      return "Scout is scanning…";
    }
    case "critic":
      return "Critic is scoring candidates";
    case "surgeon":
      return "Trimming cuts";
    case "hooks":
      return "Writing hooks";
    case "qa":
      return "Quality checks";
    default:
      return titleCase(agent);
  }
}
