"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { FAQS } from "./data";

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] as const } },
};

export function Faq() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2, once: true });
  const show = reduceMotion || inView;

  return (
    <section className="border-t border-[var(--line)]">
      <div className="mx-auto w-full max-w-3xl px-6 py-24 md:py-28">
        <h2 className="font-display text-3xl font-extrabold tracking-tight">
          Questions, answered straight.
        </h2>

        <motion.div
          ref={ref}
          className="mt-8 flex flex-col"
          initial={reduceMotion ? undefined : "hidden"}
          animate={show ? "visible" : "hidden"}
          variants={reduceMotion ? undefined : container}
        >
          {FAQS.map((faq) => (
            <motion.details
              key={faq.q}
              variants={reduceMotion ? undefined : item}
              className="group border-t border-[var(--line)] py-4 last:border-b [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-base font-bold tracking-tight">
                {faq.q}
                <span className="shrink-0 font-mono-data text-[var(--signal)] transition-transform duration-200 group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-xl text-sm text-[var(--muted)]">{faq.a}</p>
            </motion.details>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
