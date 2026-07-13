"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
 *
 * The dialog portals to <body>, outside the page's `.landing peakcut-app`
 * scope, so DialogContent re-declares those classes to pull the instrument-
 * panel tokens (--signal/--panel/--line) and dark shadcn theme in with it.
 */
export function ClipEvidence({ clip }: { clip: JobStatusClip }) {
  const { evidence, qa } = clip;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="px-2 font-mono-data text-xs text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--signal)]"
          />
        }
      >
        Why this clip →
      </DialogTrigger>
      <DialogContent className="landing dark peakcut-app max-h-[85vh] overflow-y-auto border border-[var(--line)] bg-[var(--panel-raised)] text-[var(--text)] sm:max-w-lg">
        {/* signal accent along the top edge — this is the receipt */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--signal)]/60 to-transparent"
        />
        <DialogHeader>
          <span className="font-mono-data text-[10px] tracking-[0.18em] text-[var(--signal)]">
            EVIDENCE LOG
          </span>
          <DialogTitle className="font-display text-xl font-extrabold tracking-tight">
            Why this clip
          </DialogTitle>
          <DialogDescription className="font-mono-data text-xs text-[var(--muted)]">
            Clip {clip.index}
          </DialogDescription>
        </DialogHeader>

        {!evidence ? (
          <p className="text-sm text-[var(--muted)]">No evidence recorded for this clip.</p>
        ) : (
          <div className="flex flex-col gap-6">
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

function SectionHeader({ children }: { children: string }) {
  return (
    <h3 className="flex items-center gap-2 font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)] uppercase">
      <span className="text-[var(--signal)]">▸</span>
      {children}
    </h3>
  );
}

function Claim({ text }: { text: string }) {
  return (
    <li className="flex items-baseline gap-2 font-mono-data text-xs text-[var(--muted)]">
      <span className="text-[var(--signal)]/70">·</span>
      <span className="text-[color-mix(in_oklab,var(--text)_75%,transparent)]">{text}</span>
    </li>
  );
}

function ScoreHeader({ score }: { score: Score | null }) {
  if (!score) {
    return <p className="text-sm text-[var(--muted)]">No score recorded.</p>;
  }
  const kept = score.verdict === "keep";
  return (
    <div className="flex items-end justify-between rounded-xl border border-[var(--line)] bg-[var(--ink)]/40 px-4 py-3">
      <div className="flex flex-col">
        <span className="font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)]">SCORE</span>
        <span className="font-display text-3xl font-extrabold tabular-nums text-[var(--signal)]">
          {score.total}/100
        </span>
      </div>
      <span
        className={`rounded-full border px-2.5 py-1 font-mono-data text-[11px] tracking-wide ${
          kept
            ? "border-[var(--signal)]/40 bg-[var(--signal)]/12 text-[var(--signal)]"
            : "border-[var(--line)] bg-[var(--panel)] text-[var(--muted)]"
        }`}
      >
        {score.verdict}
      </span>
    </div>
  );
}

function ComponentBreakdown({ components }: { components: Record<string, ScoreComponent> }) {
  const keys = COMPONENT_ORDER.filter((key) => key in components);
  if (keys.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader>Component breakdown</SectionHeader>
      {keys.map((key) => {
        const component = components[key];
        const pct = Math.max(0, Math.min(100, (component.score / COMPONENT_MAX) * 100));
        return (
          <div key={key} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-[var(--text)]">{humanizeComponent(key)}</span>
              <span className="font-mono-data text-xs text-[var(--muted)] tabular-nums">
                {component.score}/{COMPONENT_MAX}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[var(--signal-dim)] to-[var(--signal)]"
                style={{ width: `${pct}%` }}
              />
            </div>
            {component.evidence.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-0.5">
                {component.evidence.map((claim, i) => (
                  <Claim key={i} text={formatClaim(claim)} />
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
    <section className="flex flex-col gap-2">
      <SectionHeader>Why it was picked</SectionHeader>
      <p className="text-sm text-[var(--text)]">{humanizeSource(candidate.source)}</p>
      {candidate.evidence.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {candidate.evidence.map((claim, i) => (
            <Claim key={i} text={formatClaim(claim)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RepairsTimeline({ repairs }: { repairs: Repair[] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader>What happened to it</SectionHeader>
      <ul className="flex flex-col gap-2 border-l border-[var(--line)] pl-4">
        {repairs.map((repair, i) => (
          <li key={i} className="relative text-sm text-[var(--text)]">
            <span
              aria-hidden
              className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full border border-[var(--signal)]/50 bg-[var(--panel-raised)]"
            />
            {humanizeRepair(repair)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function QaSection({ qa }: { qa: Qa | null }) {
  if (!qa) return null;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeader>Quality checks</SectionHeader>
      {qa.passed ? (
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono-data text-xs text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
          Passed all checks
        </span>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {qa.failures.map((failure, i) => (
            <li key={i}>
              <span className="font-medium text-[var(--text)]">{humanizeQaCode(failure.code)}</span>
              <span className="text-[var(--muted)]"> — {failure.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
