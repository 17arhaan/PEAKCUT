"use client";

import { motion, useReducedMotion } from "motion/react";

const EASE = [0.16, 1, 0.3, 1] as const;

const STEPS = [
  { n: "01", label: "Ingest", sub: "Pull audio, video & transcript" },
  { n: "02", label: "Measure signals", sub: "Energy · laughter · cuts · faces" },
  { n: "03", label: "Agent crew", sub: "Score & debate every moment" },
  { n: "04", label: "Render", sub: "Cut · caption · QA · receipts" },
];

const STATS = [
  { v: "~2 min", l: "per video" },
  { v: "4", l: "agents debating" },
  { v: "24/s", l: "signals measured" },
];

/** Right-rail preview on the new-job screen: the real clip output looping under
 * an analysis scan, the pipeline the crew is about to run, and proof stats —
 * so the empty space sells the product instead of sitting blank. */
export function JobPreview() {
  const reduce = !!useReducedMotion();

  return (
    <motion.aside
      aria-hidden
      initial={reduce ? undefined : { opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? undefined : { duration: 0.55, delay: 0.1, ease: EASE }}
      className="hidden flex-col items-center gap-8 lg:flex"
    >
      {/* live product output */}
      <div className="signal-glow relative aspect-9/16 w-full max-w-[248px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--ink)]">
        <video
          src="/hero-clip.mp4"
          poster="/hero-clip-poster.jpg"
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_58%,rgba(0,0,0,0.55)_100%)]" />
        {!reduce && (
          <>
            <motion.div
              className="pointer-events-none absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-[var(--signal)]/20 to-transparent"
              initial={{ top: "-20%" }}
              animate={{ top: ["-20%", "112%"] }}
              transition={{ duration: 3, repeat: Infinity, repeatDelay: 0.4, ease: "easeInOut" }}
            />
            <motion.div
              className="pointer-events-none absolute inset-x-0 h-px bg-[var(--signal)] shadow-[0_0_12px_2px_var(--signal)]"
              initial={{ top: "-20%" }}
              animate={{ top: ["-20%", "112%"] }}
              transition={{ duration: 3, repeat: Infinity, repeatDelay: 0.4, ease: "easeInOut" }}
            />
          </>
        )}
        <span className="signal-glow absolute top-2 right-2 flex flex-col items-center rounded-full bg-[var(--signal)] px-2.5 py-1.5 text-[var(--ink)]">
          <span className="font-display text-base leading-none font-extrabold tabular-nums">87</span>
          <span className="font-mono-data text-[8px] leading-none tracking-wide">SCORE</span>
        </span>
      </div>

      {/* the pipeline the crew is about to run */}
      <div className="w-full max-w-[260px]">
        <span className="font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)]">
          WHAT THE CREW RUNS
        </span>
        <ol className="mt-4 flex flex-col gap-3.5">
          {STEPS.map((s, i) => (
            <motion.li
              key={s.n}
              initial={reduce ? undefined : { opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={reduce ? undefined : { duration: 0.4, delay: 0.25 + i * 0.09, ease: EASE }}
              className="flex items-baseline gap-3"
            >
              <span className="font-mono-data text-xs font-medium text-[var(--signal)]">{s.n}</span>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-[var(--text)]">{s.label}</span>
                <span className="font-mono-data text-[11px] text-[var(--muted)]">{s.sub}</span>
              </div>
            </motion.li>
          ))}
        </ol>
      </div>

      {/* proof stats */}
      <div className="grid w-full max-w-[260px] grid-cols-3 gap-2 border-t border-[var(--line)] pt-5">
        {STATS.map((s, i) => (
          <motion.div
            key={s.l}
            initial={reduce ? undefined : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? undefined : { duration: 0.4, delay: 0.6 + i * 0.08, ease: EASE }}
            className="flex flex-col"
          >
            <span className="font-display text-base font-extrabold text-[var(--text)]">{s.v}</span>
            <span className="font-mono-data text-[10px] leading-tight text-[var(--muted)]">{s.l}</span>
          </motion.div>
        ))}
      </div>
    </motion.aside>
  );
}
