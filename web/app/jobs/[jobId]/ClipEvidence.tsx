"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  formatClaim,
  humanizeComponent,
  humanizeQaCode,
  humanizeRepair,
  humanizeSource,
  type Candidate,
  type Qa,
  type Repair,
  type Score,
  type ScoreComponent,
} from "@/lib/format-evidence";
import type { JobStatusClip } from "@/lib/job-status";

const COMPONENT_MAX = 25;
// Fixed display order (score.components is an unordered record) -- a
// component key not present in a given clip's blob is skipped, not shown
// as zero.
const COMPONENT_ORDER = ["hook_strength", "payoff", "emotion", "quotability"];

/**
 * The "why this clip" evidence panel (W10) -- a shadcn Dialog, self-owning
 * its trigger button, so JobLive.tsx just swaps in `<ClipEvidence clip={clip} />`
 * for the disabled placeholder button it used to render. Reads only
 * clip.evidence/clip.qa, already delivered by the status route -- no extra
 * fetch.
 */
export function ClipEvidence({ clip }: { clip: JobStatusClip }) {
  const { evidence, qa } = clip;

  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>Why this clip →</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Why this clip</DialogTitle>
          <DialogDescription>Clip {clip.index}</DialogDescription>
        </DialogHeader>

        {!evidence ? (
          <p className="text-sm text-muted-foreground">No evidence recorded for this clip.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <ScoreHeader score={evidence.score} />

            {evidence.score ? <ComponentBreakdown components={evidence.score.components} /> : null}

            <CandidateSection candidate={evidence.candidate} />

            {evidence.repairs.length > 0 ? <RepairsTimeline repairs={evidence.repairs} /> : null}

            <QaSection qa={qa} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScoreHeader({ score }: { score: Score | null }) {
  if (!score) {
    return <p className="text-sm text-muted-foreground">No score recorded.</p>;
  }
  return (
    <div className="flex items-center justify-between">
      <span className="text-2xl font-semibold">{score.total}/100</span>
      <Badge variant={score.verdict === "keep" ? "default" : "outline"}>{score.verdict}</Badge>
    </div>
  );
}

function ComponentBreakdown({ components }: { components: Record<string, ScoreComponent> }) {
  const keys = COMPONENT_ORDER.filter((key) => key in components);
  if (keys.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Component breakdown</h3>
      {keys.map((key) => {
        const component = components[key];
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{humanizeComponent(key)}</span>
              <span className="text-muted-foreground tabular-nums">
                {component.score}/{COMPONENT_MAX}
              </span>
            </div>
            <Progress value={component.score} max={COMPONENT_MAX} />
            {component.evidence.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {component.evidence.map((claim, i) => (
                  <li key={i}>{formatClaim(claim)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function CandidateSection({ candidate }: { candidate: Candidate }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Why it was picked</h3>
      <p className="text-sm">{humanizeSource(candidate.source)}</p>
      {candidate.evidence.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {candidate.evidence.map((claim, i) => (
            <li key={i}>{formatClaim(claim)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RepairsTimeline({ repairs }: { repairs: Repair[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What happened to it</h3>
      <ul className="flex flex-col gap-0.5 text-sm">
        {repairs.map((repair, i) => (
          <li key={i}>{humanizeRepair(repair)}</li>
        ))}
      </ul>
    </section>
  );
}

function QaSection({ qa }: { qa: Qa | null }) {
  if (!qa) return null;

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Quality checks</h3>
      {qa.passed ? (
        <Badge variant="outline" className="w-fit text-emerald-600 dark:text-emerald-400">
          Passed all checks
        </Badge>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {qa.failures.map((failure, i) => (
            <li key={i}>
              <span className="font-medium">{humanizeQaCode(failure.code)}</span>
              <span className="text-muted-foreground"> — {failure.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
