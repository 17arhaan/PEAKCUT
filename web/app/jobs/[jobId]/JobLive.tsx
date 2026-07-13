"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { JobStatusBadge } from "@/components/job-status-badge";
import { ClipEvidence } from "@/app/jobs/[jobId]/ClipEvidence";
import { PipelineLive } from "@/app/jobs/[jobId]/Pipeline";
import { Stagger, StaggerItem } from "@/app/_components/motion";
import { reRenderStyle } from "@/actions/jobs";
import { humanizeStage } from "@/lib/job-events";
import type { JobStatus, JobStatusClip } from "@/lib/job-status";
import type { CaptionStyle } from "@/lib/worker";

const POLL_INTERVAL_MS = 2000;
const CAPTION_STYLES: readonly CaptionStyle[] = ["s1", "s2", "s3"];
const STYLE_LABELS: Record<CaptionStyle, string> = { s1: "Style 1", s2: "Style 2", s3: "Style 3" };

function isTerminal(status: JobStatus["status"]): boolean {
  return status === "done" || status === "failed";
}

export function JobLive({ jobId, initialData }: { jobId: string; initialData: JobStatus }) {
  const [data, setData] = useState(initialData);

  // Polls the status route every 2s. The effect re-runs (re-arming or
  // tearing down the interval) only when `data.status` actually changes, so
  // a steady "processing" tick doesn't restart the timer -- and once status
  // flips to a terminal value the effect body below returns before setting
  // an interval, while its cleanup (always run before a re-run, and on
  // unmount) clears whatever interval was previously running. No dangling
  // timer survives past done/failed or a component unmount.
  useEffect(() => {
    if (isTerminal(data.status)) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/status`);
        if (!res.ok || cancelled) return;
        const next = (await res.json()) as JobStatus;
        if (!cancelled) setData(next);
      } catch {
        // transient network error -- next tick retries
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, data.status]);

  const hasClips = data.clips.length > 0;

  return (
    <div className="flex flex-col gap-6">
      {data.status === "failed" ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-6">
          <span className="font-mono-data text-[11px] tracking-[0.15em] text-destructive">
            FAILED
          </span>
          <h1 className="mt-1 font-display text-xl font-extrabold tracking-tight text-destructive">
            Job failed
          </h1>
          <p className="mt-2 text-sm text-destructive/90">
            {data.error ?? "Something went wrong."}
          </p>
        </div>
      ) : data.status === "done" ? (
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--signal)]">
              DONE
            </span>
            <h1 className="font-display text-2xl font-extrabold tracking-tight">
              Your clips are ready.
            </h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {data.clips.filter((c) => c.status !== "dropped").length} clips, each with the evidence behind its score.
            </p>
          </div>
          <JobStatusBadge status={data.status} />
        </div>
      ) : !hasClips ? (
        <PipelineLive data={data} />
      ) : (
        // clips already exist + still processing = a re-render (restyle) in flight
        <div className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)]/50 px-4 py-3">
          <Loader2 className="size-4 animate-spin text-[var(--signal)]" aria-hidden />
          <span className="text-sm text-[var(--text)]">{humanizeStage(data.stage)}</span>
        </div>
      )}

      {hasClips ? (
        <StyleSelector
          jobId={jobId}
          activeStyle={data.active_style}
          jobStatus={data.status}
          onRestyled={setData}
        />
      ) : null}

      {hasClips ? (
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" amount={0.05}>
          {data.clips.map((clip) => (
            <StaggerItem key={clip.index} hover={clip.status !== "dropped"} className="h-full">
              <ClipCard clip={clip} />
            </StaggerItem>
          ))}
        </Stagger>
      ) : null}
    </div>
  );
}

/**
 * W11 caption-style switcher: re-renders the clip grid's media in a
 * different karaoke caption preset without re-running the pipeline. Only
 * enabled when the job is 'done' and no restyle is in flight (reRenderStyle
 * server-side rejects any other status). `pendingStyle` gates the buttons
 * while a restyle request is in flight, preventing double-clicks from firing
 * multiple concurrent restyles. `pendingStyle` remembers WHICH style is in
 * flight for the "Applying…" label -- it's set optimistically on click
 * (before the server action round-trips), which matters for e2e under
 * STUB_WORKER (lib/worker.ts's StubWorker.renderStyle is a no-op, so the
 * job never reaches 'done' again on its own -- the test only needs to observe
 * 'processing' + the label).
 */
function StyleSelector({
  jobId,
  activeStyle,
  jobStatus,
  onRestyled,
}: {
  jobId: string;
  activeStyle: JobStatus["active_style"];
  jobStatus: JobStatus["status"];
  onRestyled: (next: JobStatus) => void;
}) {
  const [pendingStyle, setPendingStyle] = useState<CaptionStyle | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(style: CaptionStyle) {
    setError(null);
    setPendingStyle(style);
    try {
      await reRenderStyle(jobId, style);
      const res = await fetch(`/api/jobs/${jobId}/status`);
      if (res.ok) onRestyled(await res.json());
    } catch (err) {
      setPendingStyle(null);
      setError(err instanceof Error ? err.message : "Restyle failed");
    }
  }

  const canRestyle = jobStatus === "done" && !pendingStyle;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono-data text-[11px] tracking-wide text-[var(--muted)] uppercase">
          Caption style:
        </span>
        <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)]/50 p-1">
          {CAPTION_STYLES.map((style) => {
            const isActive = activeStyle === style;
            return (
              <button
                key={style}
                type="button"
                disabled={!canRestyle}
                onClick={() => handleClick(style)}
                aria-pressed={isActive}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
                  isActive
                    ? "bg-[var(--signal)] text-[var(--ink)] shadow-[0_0_16px_-4px_rgba(245,179,1,0.6)]"
                    : "text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
                }`}
              >
                {STYLE_LABELS[style]}
              </button>
            );
          })}
        </div>
        {pendingStyle && jobStatus === "processing" ? (
          <span className="flex items-center gap-1.5 font-mono-data text-xs text-[var(--muted)]">
            <Loader2 className="size-3 animate-spin text-[var(--signal)]" aria-hidden />
            Applying {STYLE_LABELS[pendingStyle]}…
          </span>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function ClipCard({ clip }: { clip: JobStatusClip }) {
  if (clip.status === "dropped") {
    return (
      <div className="flex h-full flex-col justify-center rounded-2xl border border-dashed border-[var(--line)] bg-[var(--panel)]/20 p-5">
        <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--muted)]">
          CLIP {clip.index}
        </span>
        <p className="mt-1.5 text-sm text-[var(--muted)]">
          Dropped: {clip.dropped_reason ?? "unknown"}
        </p>
      </div>
    );
  }

  return (
    <div className="group flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)]/50 transition-colors duration-200 hover:border-[var(--signal)]/40">
      {clip.mp4_url ? (
        <div className="relative aspect-[9/16] w-full overflow-hidden bg-black">
          <video
            src={clip.mp4_url}
            poster={clip.thumb_url ?? undefined}
            controls
            className="h-full w-full object-cover"
          />
          {clip.score !== null ? (
            <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-full border border-[var(--signal)]/40 bg-[var(--ink)]/80 px-2.5 py-1 font-mono-data text-[11px] font-semibold tabular-nums text-[var(--signal)] backdrop-blur-sm">
              {clip.score}/100
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="line-clamp-2 font-display text-sm font-bold leading-snug tracking-tight">
          {clip.hook ?? `Clip ${clip.index}`}
        </h3>
        <div className="mt-auto flex items-center justify-between gap-2">
          <ClipEvidence clip={clip} />
          {clip.mp4_url ? (
            <Button
              size="sm"
              render={<a href={clip.mp4_url} download />}
              className="gap-1.5 bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all hover:-translate-y-0.5 hover:bg-[color-mix(in_oklab,var(--signal)_92%,var(--text))]"
            >
              <Download className="size-3.5" aria-hidden />
              Download
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
