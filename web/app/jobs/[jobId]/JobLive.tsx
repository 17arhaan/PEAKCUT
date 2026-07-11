"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { JobStatusBadge } from "@/components/job-status-badge";
import { humanizeEvent, humanizeStage } from "@/lib/job-events";
import type { JobStatus, JobStatusClip } from "@/lib/job-status";

const POLL_INTERVAL_MS = 2000;

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

  const progressPct = Math.round(data.progress * 100);
  const hasClips = data.clips.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Job</h1>
        <JobStatusBadge status={data.status} />
      </div>

      {data.status === "failed" ? (
        <Card className="border border-destructive/40 bg-destructive/10">
          <CardHeader>
            <CardTitle className="text-destructive">Job failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-destructive">
            {data.error ?? "Something went wrong."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{humanizeStage(data.stage)}</p>
          <Progress value={progressPct} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Activity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          {data.events.length === 0 ? (
            <p>Waiting for the crew to get started…</p>
          ) : (
            data.events.map((event, i) => (
              <p key={`${event.agent}-${event.created_at}-${i}`}>
                {humanizeEvent(event.agent, event.action, event.payload)}
              </p>
            ))
          )}
        </CardContent>
      </Card>

      {!hasClips && data.status !== "done" && data.status !== "failed" ? (
        <p className="text-sm text-muted-foreground">Working on your clips…</p>
      ) : null}

      {hasClips ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.clips.map((clip) => (
            <ClipCard key={clip.index} clip={clip} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ClipCard({ clip }: { clip: JobStatusClip }) {
  if (clip.status === "dropped") {
    return (
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle className="text-sm">Clip {clip.index}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Dropped: {clip.dropped_reason ?? "unknown"}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {clip.mp4_url ? (
        <video
          src={clip.mp4_url}
          poster={clip.thumb_url ?? undefined}
          controls
          className="aspect-[9/16] w-full rounded-t-xl bg-black object-cover"
        />
      ) : null}
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="line-clamp-2 text-sm">{clip.hook ?? `Clip ${clip.index}`}</CardTitle>
          {clip.score !== null ? <Badge variant="outline">{clip.score}/100</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        {/* Evidence panel is W10 -- placeholder only, no dialog yet. */}
        <Button size="sm" variant="ghost" disabled>
          Why this clip →
        </Button>
        {clip.mp4_url ? (
          <Button size="sm" render={<a href={clip.mp4_url} download />}>
            Download
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
