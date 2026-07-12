"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useInView, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { TIERS } from "./data";

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] as const } },
};

export function Pricing() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3, once: true });
  const show = reduceMotion || inView;

  return (
    <section id="pricing" className="border-t border-[var(--line)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 md:py-28">
        <h2 className="font-display text-3xl font-extrabold tracking-tight">
          Pricing
        </h2>
        <p className="mt-2 max-w-md text-[var(--muted)]">
          Pay for minutes processed, not seats. Cancel anytime.
        </p>
        <motion.div
          ref={ref}
          className="mt-10 grid gap-6 sm:grid-cols-3"
          initial={reduceMotion ? undefined : "hidden"}
          animate={show ? "visible" : "hidden"}
          variants={reduceMotion ? undefined : container}
        >
          {TIERS.map((tier) => (
            <motion.div
              key={tier.name}
              variants={reduceMotion ? undefined : item}
              whileHover={reduceMotion ? undefined : { y: -6 }}
              transition={{ type: "spring", stiffness: 300, damping: 24 }}
              className={`flex flex-col rounded-2xl border p-6 transition-shadow duration-200 ${
                tier.highlighted
                  ? "shimmer-border signal-glow border-transparent bg-[var(--panel)] sm:-translate-y-2"
                  : "border-[var(--line)] bg-[var(--panel)]/50 hover:border-[var(--line)] hover:shadow-xl hover:shadow-black/20"
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold">
                  {tier.name}
                </h3>
                {tier.highlighted && (
                  <span className="rounded-full bg-[var(--signal)] px-2 py-0.5 font-mono-data text-[10px] font-medium text-[var(--ink)]">
                    Most popular
                  </span>
                )}
              </div>
              <p className="mt-3 font-display text-3xl font-extrabold tracking-tight">
                {tier.price}
                <span className="font-mono-data text-sm font-normal text-[var(--muted)]">
                  {" "}
                  {tier.period}
                </span>
              </p>
              <ul className="mt-6 flex flex-1 flex-col gap-2 text-sm text-[var(--muted)]">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span className="text-[var(--signal)]">▸</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className={`mt-6 w-full transition-all duration-200 hover:-translate-y-0.5 ${
                  tier.highlighted
                    ? "bg-[var(--signal)] font-semibold text-[var(--ink)] hover:bg-[var(--signal)]/90"
                    : "border border-[var(--line)] bg-transparent text-[var(--text)] hover:bg-[var(--line)]/50"
                }`}
                render={<Link href="/signin" />}
              >
                {tier.cta}
              </Button>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
