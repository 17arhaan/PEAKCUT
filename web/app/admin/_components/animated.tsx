"use client";

import { type ReactNode, useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCountUp } from "@/app/_components/landing/use-count-up";

export interface StatConfig {
  key: string;
  label: string;
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  sub?: string;
  /** Amber signature glow — reserve for the one or two metrics that matter most. */
  glow?: boolean;
}

const gridContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};

const gridItem = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } },
};

function StatCardItem({ stat, active }: { stat: StatConfig; active: boolean }) {
  const count = useCountUp(stat.value, { start: active, duration: 1.1, decimals: stat.decimals ?? 0 });
  const shown = stat.decimals ? count.toFixed(stat.decimals) : count.toString();

  return (
    <motion.div variants={gridItem} className="transition-transform duration-200 ease-out hover:-translate-y-0.5">
      <Card className={`gap-1 py-4 ${stat.glow ? "signal-glow" : ""}`}>
        <CardHeader className="gap-0 px-4">
          <CardDescription className="font-mono-data text-[11px] tracking-wide uppercase">
            {stat.label}
          </CardDescription>
          <CardTitle className="font-display text-2xl font-extrabold tabular-nums">
            {stat.prefix ?? ""}
            {shown}
            {stat.suffix ?? ""}
          </CardTitle>
          {stat.sub && <CardDescription className="font-mono-data text-[11px]">{stat.sub}</CardDescription>}
        </CardHeader>
      </Card>
    </motion.div>
  );
}

/** The dashboard's one signature moment: stat cards stagger in and count up
 * from zero the first time they scroll into view. Fully static (final
 * values, no motion) under prefers-reduced-motion. */
export function StatsGrid({ stats }: { stats: StatConfig[] }) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3, once: true });
  const active = reduceMotion ? true : inView;

  return (
    <motion.div
      ref={ref}
      className="grid grid-cols-2 gap-4 md:grid-cols-3"
      initial={reduceMotion ? undefined : "hidden"}
      animate={reduceMotion || inView ? "visible" : "hidden"}
      variants={reduceMotion ? undefined : gridContainer}
    >
      {stats.map((stat) => (
        <StatCardItem key={stat.key} stat={stat} active={active} />
      ))}
    </motion.div>
  );
}

/** Quiet fade-up scroll reveal for section blocks below the fold — plays
 * once, never replays on scroll-back (a monitoring cockpit shouldn't be
 * distracting on a second pass). */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2, once: true });

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
      animate={reduceMotion || inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
      transition={reduceMotion ? undefined : { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const }}
    >
      {children}
    </motion.div>
  );
}
