"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { STEPS } from "./data";

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.14, delayChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] as const } },
};

export function HowItWorks() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLOListElement>(null);
  const inView = useInView(ref, { amount: 0.4, once: true });
  const show = reduceMotion || inView;

  return (
    <section id="how-it-works" className="mx-auto w-full max-w-6xl px-6 py-24 md:py-28">
      <h2 className="font-mono-data text-xs font-medium tracking-[0.15em] text-[var(--muted)]">
        HOW IT WORKS
      </h2>

      <motion.ol
        ref={ref}
        className="relative mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4"
        initial={reduceMotion ? undefined : "hidden"}
        animate={show ? "visible" : "hidden"}
        variants={reduceMotion ? undefined : container}
      >
        {/* connecting signal trace between step numbers, desktop only */}
        <svg
          aria-hidden
          viewBox="0 0 100 1"
          preserveAspectRatio="none"
          className="pointer-events-none absolute top-[10px] left-[6%] hidden h-px w-[88%] lg:block"
        >
          <line x1="0" y1="0.5" x2="100" y2="0.5" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <motion.line
            x1="0"
            y1="0.5"
            x2="100"
            y2="0.5"
            stroke="var(--signal)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            initial={reduceMotion ? undefined : { pathLength: 0, opacity: 0.7 }}
            animate={show ? { pathLength: 1, opacity: 0.7 } : { pathLength: 0 }}
            transition={reduceMotion ? undefined : { duration: 1, delay: 0.15, ease: [0.16, 1, 0.3, 1] as const }}
          />
        </svg>

        {STEPS.map((step) => (
          <motion.li key={step.index} className="flex flex-col gap-2" variants={reduceMotion ? undefined : item}>
            <span className="font-mono-data text-sm text-[var(--signal)]">
              {step.index}
            </span>
            <h3 className="font-display text-lg font-bold tracking-tight">
              {step.title}
            </h3>
            <p className="text-sm text-[var(--muted)]">{step.body}</p>
          </motion.li>
        ))}
      </motion.ol>
    </section>
  );
}
