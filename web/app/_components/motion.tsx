"use client";

import { type ReactNode, useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

// Shared app-wide motion primitives. The landing sections have their own
// bespoke choreography; these are the reusable building blocks for the signed-in
// app (dashboard, jobs, settings) so every page moves with one consistent
// signature — a soft fade + rise on the same cubic-bezier the landing uses.

const EASE = [0.16, 1, 0.3, 1] as const;

/** Route-change entrance. Dropped into a Next.js `template.tsx` so it re-mounts
 * and replays on every navigation into the subtree — the whole page content
 * fades and rises as one. Static under reduced-motion. */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

const staggerItem = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE } },
};

/** A container whose direct `StaggerItem` children reveal one after another the
 * first time it enters the viewport. */
export function Stagger({
  children,
  className,
  amount = 0.15,
}: {
  children: ReactNode;
  className?: string;
  amount?: number;
}) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount, once: true });

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={reduceMotion ? undefined : "hidden"}
      animate={reduceMotion || inView ? "visible" : "hidden"}
      variants={reduceMotion ? undefined : staggerContainer}
    >
      {children}
    </motion.div>
  );
}

/** One child of a `Stagger`. Pass `as` to render a different element (e.g. a
 * table row) while keeping the reveal. */
export function StaggerItem({
  children,
  className,
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      variants={reduceMotion ? undefined : staggerItem}
      whileHover={hover && !reduceMotion ? { y: -4 } : undefined}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Quiet fade-up for a single block on first view. */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2, once: true });

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
      animate={reduceMotion || inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
      transition={reduceMotion ? undefined : { duration: 0.5, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}
