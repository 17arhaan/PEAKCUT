"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { humanizeEvent } from "@/lib/job-events";
import type { JobStatus } from "@/lib/job-status";

// The real stages the worker writes to jobs.stage, presented as the pipeline.
const STAGES = [
  { key: "ingest", label: "Ingest", sub: "Pulling the source" },
  { key: "signals", label: "Signals", sub: "Measuring every second" },
  { key: "crew", label: "Agent crew", sub: "Scoring & debating" },
  { key: "render", label: "Render", sub: "Cut · caption · QA" },
] as const;

function stageIndex(stage: string | null, status: JobStatus["status"]): number {
  if (status === "done") return STAGES.length;
  const i = STAGES.findIndex((s) => s.key === stage);
  return i === -1 ? 0 : i;
}

function formatEta(sec: number | null): string {
  if (sec === null) return "estimating…";
  if (sec <= 3) return "almost done";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `~${m}m ${s.toString().padStart(2, "0")}s` : `~${s}s`;
}

/** Self-correcting ETA: infers the current progress-rate from recent polls and
 * extrapolates the remaining time, then ticks the display down each second so
 * the countdown feels live between polls. */
function useLiveEta(progress: number, status: JobStatus["status"]): number | null {
  const samples = useRef<{ t: number; p: number }[]>([]);
  const [anchor, setAnchor] = useState<{ eta: number; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The ETA is extrapolated from a time-series of poll samples -- inherently
  // stateful across renders, not derivable during render, so the anchor is
  // legitimately set from this effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (status === "done" || status === "failed") {
      setAnchor({ eta: 0, at: Date.now() });
      return;
    }
    const t = Date.now();
    const s = samples.current;
    if (s.length === 0 || progress > s[s.length - 1].p) s.push({ t, p: progress });
    while (s.length > 6) s.shift();
    if (s.length >= 2 && progress > 0 && progress < 1) {
      const a = s[0];
      const b = s[s.length - 1];
      const rate = (b.p - a.p) / Math.max(1, (b.t - a.t) / 1000);
      if (rate > 0) setAnchor({ eta: (1 - progress) / rate, at: t });
    }
  }, [progress, status]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (status === "done" || status === "failed") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (status === "done") return 0;
  if (!anchor) return null;
  return Math.max(0, anchor.eta - (now - anchor.at) / 1000);
}

function ScanAmbient({ reduce }: { reduce: boolean }) {
  if (reduce) return null;
  return (
    <>
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-[var(--signal)]/[0.06] to-transparent"
        initial={{ top: "-20%" }}
        animate={{ top: ["-20%", "120%"] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05] [background-image:linear-gradient(var(--line)_1px,transparent_1px)] [background-size:100%_28px]"
      />
    </>
  );
}

function StageRail({ current, reduce }: { current: number; reduce: boolean }) {
  return (
    <div className="relative flex items-start justify-between gap-2">
      {STAGES.map((stage, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={stage.key} className="relative flex flex-1 flex-col items-center text-center">
            {/* connector to the next stage */}
            {i < STAGES.length - 1 && (
              <div className="absolute top-4 left-1/2 h-px w-full overflow-hidden bg-[var(--line)]">
                <motion.div
                  className="h-full bg-gradient-to-r from-[var(--signal)] to-[var(--pulse)]"
                  initial={false}
                  animate={{ width: i < current ? "100%" : "0%" }}
                  transition={{ duration: 0.6, ease: "easeInOut" }}
                />
                {active && !reduce && (
                  <motion.div
                    className="absolute top-0 h-full w-8 bg-gradient-to-r from-transparent via-[var(--signal)] to-transparent"
                    initial={{ left: "-32px" }}
                    animate={{ left: ["-32px", "100%"] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
                  />
                )}
              </div>
            )}

            <motion.div
              className={`relative z-10 flex size-8 items-center justify-center rounded-full border font-mono-data text-xs ${
                done
                  ? "border-[var(--signal)] bg-[var(--signal)] text-[var(--ink)]"
                  : active
                    ? "border-[var(--signal)] bg-[var(--panel)] text-[var(--signal)]"
                    : "border-[var(--line)] bg-[var(--panel)] text-[var(--muted)]"
              }`}
              animate={
                active && !reduce
                  ? { boxShadow: ["0 0 0px rgba(245,179,1,0)", "0 0 16px 2px rgba(245,179,1,0.5)", "0 0 0px rgba(245,179,1,0)"] }
                  : undefined
              }
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            >
              {done ? "✓" : i + 1}
              {active && !reduce && (
                <motion.span
                  className="absolute inset-0 rounded-full border border-[var(--signal)]"
                  animate={{ scale: [1, 1.8], opacity: [0.6, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                />
              )}
            </motion.div>

            <span className={`mt-2 text-xs font-medium ${active || done ? "text-[var(--text)]" : "text-[var(--muted)]"}`}>
              {stage.label}
            </span>
            <span className="mt-0.5 hidden font-mono-data text-[10px] text-[var(--muted)] sm:block">
              {stage.sub}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CrewFeed({ events, reduce }: { events: JobStatus["events"]; reduce: boolean }) {
  const recent = events.slice(-7).reverse();
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--ink)]/40 p-3">
      <div className="mb-2 flex items-center gap-2 font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)]">
        <span className="relative flex size-1.5">
          {!reduce && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--signal)] opacity-75" />
          )}
          <span className="relative inline-flex size-1.5 rounded-full bg-[var(--signal)]" />
        </span>
        LIVE · CREW ACTIVITY
      </div>
      <div className="flex min-h-[7rem] flex-col gap-1.5 font-mono-data text-xs">
        <AnimatePresence initial={false}>
          {recent.length === 0 ? (
            <motion.p key="waiting" className="text-[var(--muted)]">
              Waiting for the crew to get started…
            </motion.p>
          ) : (
            recent.map((e, i) => (
              <motion.p
                key={`${e.created_at}-${e.agent}-${e.action}-${i}`}
                initial={reduce ? false : { opacity: 0, x: -8, backgroundColor: "rgba(245,179,1,0.12)" }}
                animate={{ opacity: i === 0 ? 1 : 0.55 - i * 0.05, x: 0, backgroundColor: "rgba(245,179,1,0)" }}
                transition={{ duration: 0.4 }}
                className="flex items-baseline gap-2 rounded px-1 text-[var(--text)]"
              >
                <span className="text-[var(--signal)]">▸</span>
                <span>{humanizeEvent(e.agent, e.action, e.payload)}</span>
              </motion.p>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function PipelineLive({ data }: { data: JobStatus }) {
  const reduce = !!useReducedMotion();
  const eta = useLiveEta(data.progress, data.status);
  const pct = Math.round(data.progress * 100);
  const current = stageIndex(data.stage, data.status);

  return (
    <div className="signal-glow relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel)_70%,transparent)] p-6 font-body backdrop-blur-sm sm:p-8">
      <ScanAmbient reduce={reduce} />

      <div className="relative z-10 flex flex-col gap-6">
        {/* headline: what's happening + live ETA */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--signal)]">
              PROCESSING
            </span>
            <p className="mt-1 font-display text-2xl font-extrabold tracking-tight">
              {STAGES[Math.min(current, STAGES.length - 1)].label}
              <span className="text-[var(--muted)]">.</span>
            </p>
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              {STAGES[Math.min(current, STAGES.length - 1)].sub}
            </p>
          </div>
          <div className="text-right">
            <span className="font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)]">
              ETA
            </span>
            <p className="font-display text-2xl font-extrabold tabular-nums text-[var(--signal)]">
              {formatEta(eta)}
            </p>
          </div>
        </div>

        {/* progress bar with a moving shimmer */}
        <div>
          <div className="mb-1.5 flex justify-between font-mono-data text-[10px] text-[var(--muted)]">
            <span>{pct}% complete</span>
            <span>{data.status}</span>
          </div>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--line)]">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-[var(--signal)] to-[var(--pulse)]"
              initial={false}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
            {!reduce && (
              <motion.div
                className="absolute top-0 h-full w-16 bg-gradient-to-r from-transparent via-white/40 to-transparent"
                initial={{ left: "-64px" }}
                animate={{ left: ["-64px", "100%"] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </div>
        </div>

        <StageRail current={current} reduce={reduce} />
        <CrewFeed events={data.events} reduce={reduce} />
      </div>
    </div>
  );
}
