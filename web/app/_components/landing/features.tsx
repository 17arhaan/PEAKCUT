"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { Crop, Captions, Wand2, Link2, Zap, type LucideIcon } from "lucide-react";
import { EVIDENCE_ROWS, FEATURES, VERDICT_ROW } from "./data";

const ICONS: Record<string, LucideIcon> = { Crop, Captions, Wand2, Link2, Zap };
const AREAS = ["c1", "c2", "c3", "c4", "c5"] as const;

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } },
};

export function Features() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2, once: true });
  const show = reduceMotion || inView;

  return (
    <section className="border-t border-[var(--line)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 md:py-28">
        <h2 className="font-mono-data text-xs font-medium tracking-[0.15em] text-[var(--muted)]">
          WHAT SHIPS WITH EVERY CLIP
        </h2>

        <motion.div
          ref={ref}
          className="bento-grid mt-10"
          initial={reduceMotion ? undefined : "hidden"}
          animate={show ? "visible" : "hidden"}
          variants={reduceMotion ? undefined : container}
        >
          {/* the hero bento cell: the differentiator itself — cited evidence,
              not a black-box score */}
          <motion.div
            variants={reduceMotion ? undefined : item}
            className="signal-glow bento-big flex flex-col justify-between gap-6 rounded-2xl border border-[var(--line)] bg-[var(--panel)]/60 p-6 sm:flex-row sm:items-center md:p-8"
          >
            <div className="flex max-w-sm flex-col gap-3">
              <h3 className="font-display text-2xl font-extrabold tracking-tight text-balance">
                Every other clip tool is a black box.
              </h3>
              <p className="text-sm text-[var(--muted)]">
                They hand you a score with no explanation. We cite the measured
                signals behind it — the exact energy spike, the laugh, the quote —
                so you can trust the pick or overrule it in one look.
              </p>
              <div className="mt-1 flex flex-col gap-2 font-mono-data text-sm">
                <div className="flex items-center gap-2 text-[var(--muted)] line-through decoration-[var(--line)]">
                  <span>score: 84</span>
                  <span className="text-xs">— black box</span>
                </div>
                <div className="flex items-center gap-2 text-[var(--text)]">
                  <span className="text-[var(--signal)]">score: 87</span>
                  <span className="text-xs text-[var(--muted)]">— cited: energy +2.1σ, laughter, quote</span>
                </div>
              </div>
            </div>

            <div className="w-full max-w-xs shrink-0 rounded-xl border border-[var(--line)] bg-[var(--ink)]/60 p-4">
              <span className="font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)]">
                EVIDENCE LOG · CLIP 04
              </span>
              <dl className="mt-2 font-mono-data text-xs">
                {[...EVIDENCE_ROWS, VERDICT_ROW].map((row) => (
                  <div
                    key={row.marker}
                    className="flex items-baseline justify-between gap-3 border-t border-[var(--line)] py-2 first:border-t-0"
                  >
                    <dt className="flex items-baseline gap-1.5 text-[var(--muted)]">
                      <span className="text-[var(--signal)]">▸</span>
                      {row.marker}
                    </dt>
                    <dd
                      className={`truncate text-right ${
                        "isVerdict" in row ? "font-medium text-[var(--signal)]" : "text-[var(--text)]"
                      }`}
                    >
                      {row.value}
                      {row.time && <span className="ml-2 text-[var(--muted)]">{row.time}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </motion.div>

          {FEATURES.map((feature, i) => {
            const Icon = ICONS[feature.icon];
            return (
              <motion.div
                key={feature.title}
                variants={reduceMotion ? undefined : item}
                whileHover={reduceMotion ? undefined : { y: -4 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
                className={`bento-${AREAS[i]} flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--panel)]/50 p-5 transition-colors duration-200 hover:border-[var(--signal)]/40`}
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--signal)]/12 text-[var(--signal)]">
                  <Icon className="size-4.5" strokeWidth={1.75} />
                </span>
                <h3 className="font-display text-base font-bold tracking-tight">{feature.title}</h3>
                <p className="text-sm text-[var(--muted)]">{feature.body}</p>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
