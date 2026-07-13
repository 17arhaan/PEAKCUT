"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { DEMO_CLIP } from "./data";
import { useCountUp } from "./use-count-up";

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.12, delayChildren: 0.15 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const } },
};

const rowVariant = {
  hidden: { opacity: 0, x: 12 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] as const } },
};

export function Demo() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3, once: true });
  const show = reduceMotion || inView;
  const score = useCountUp(DEMO_CLIP.score, { start: show, duration: 1, delay: 0.3 });

  return (
    <section className="border-t border-[var(--line)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 md:py-28">
        <h2 className="font-mono-data text-xs font-medium tracking-[0.15em] text-[var(--muted)]">
          SEE IT IN ACTION
        </h2>
        <p className="mt-3 max-w-lg font-display text-2xl font-extrabold tracking-tight text-balance sm:text-3xl">
          A real clip, with its real receipts.
        </p>

        <motion.div
          ref={ref}
          className="mt-10 grid gap-8 rounded-2xl border border-[var(--line)] bg-[var(--panel)]/40 p-6 md:grid-cols-[minmax(0,220px)_1fr] md:p-8"
          initial={reduceMotion ? undefined : "hidden"}
          animate={show ? "visible" : "hidden"}
          variants={reduceMotion ? undefined : container}
        >
          <motion.div variants={reduceMotion ? undefined : fadeUp} className="mx-auto w-full max-w-[220px]">
            <div className="signal-glow relative aspect-9/16 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--ink)]">
              <video
                aria-hidden
                className="absolute inset-0 h-full w-full object-cover"
                src="/hero-clip.mp4"
                poster="/hero-clip-poster.jpg"
                autoPlay
                muted
                loop
                playsInline
              />
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_58%,rgba(0,0,0,0.5)_100%)]" />
              <span className="signal-glow absolute top-2 right-2 flex flex-col items-center rounded-full bg-[var(--signal)] px-2.5 py-1.5 text-[var(--ink)]">
                <span className="font-display text-lg leading-none font-extrabold tabular-nums">
                  {score}
                </span>
                <span className="font-mono-data text-[8px] leading-none tracking-wide">
                  SCORE
                </span>
              </span>
            </div>
          </motion.div>

          <motion.div variants={reduceMotion ? undefined : fadeUp} className="flex flex-col justify-center gap-4">
            <span className="font-mono-data text-[10px] tracking-[0.15em] text-[var(--muted)]">
              WHY THIS CLIP
            </span>
            <dl className="font-mono-data text-sm">
              {[...DEMO_CLIP.rows, DEMO_CLIP.verdict].map((row) => (
                <motion.div
                  key={row.marker}
                  variants={reduceMotion ? undefined : rowVariant}
                  className="flex items-baseline justify-between gap-3 border-t border-[var(--line)] py-2.5 first:border-t-0"
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
                </motion.div>
              ))}
            </dl>
            <p className="text-sm text-[var(--muted)]">
              This clip scored 92 because three independent signals lined up in the same eight seconds —
              a scene cut, a speech-rate spike, and a quotable line. That&rsquo;s what the agent crew debates, not a guess.
            </p>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
