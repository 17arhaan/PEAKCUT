"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { TRUST_STATS } from "./data";
import { useCountUp } from "./use-count-up";

function Stat({ value, prefix, suffix, decimals, label, active }: (typeof TRUST_STATS)[number] & { active: boolean }) {
  const count = useCountUp(value, { start: active, duration: 1, decimals });
  const shown = decimals ? count.toFixed(decimals) : count.toString();

  return (
    <div className="flex flex-col gap-1">
      <span className="font-display text-3xl font-extrabold tracking-tight text-[var(--signal)] tabular-nums">
        {prefix ?? ""}
        {shown}
        {suffix}
      </span>
      <span className="font-mono-data text-xs text-[var(--muted)]">{label}</span>
    </div>
  );
}

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.09 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } },
};

export function TrustStrip() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5, once: true });

  return (
    <section className="border-y border-[var(--line)] bg-[var(--panel)]/40">
      <motion.div
        ref={ref}
        className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-8 px-6 py-10 sm:grid-cols-4"
        initial={reduceMotion ? undefined : "hidden"}
        animate={reduceMotion || inView ? "visible" : "hidden"}
        variants={reduceMotion ? undefined : container}
      >
        {TRUST_STATS.map((stat) => (
          <motion.div key={stat.label} variants={reduceMotion ? undefined : item}>
            <Stat {...stat} active={reduceMotion ? true : inView} />
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
