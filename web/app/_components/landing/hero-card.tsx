"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { EVIDENCE_ROWS, VERDICT_ROW } from "./data";
import { useCountUp } from "./use-count-up";

// Timing spine for the orchestrated build (seconds from mount). Evidence
// rows land on a 0.25s stagger starting at ROW_START; the score counts up
// once the last row has landed; the verdict stamps in last.
const ROW_START = 0.55;
const ROW_GAP = 0.25;
const SCORE_DELAY = ROW_START + EVIDENCE_ROWS.length * ROW_GAP + 0.05;
const SCORE_DURATION = 0.9;
const VERDICT_DELAY = SCORE_DELAY + SCORE_DURATION + 0.15;

function ScoreBadge({ reduceMotion }: { reduceMotion: boolean }) {
  const score = useCountUp(87, { duration: SCORE_DURATION, delay: SCORE_DELAY });

  return (
    <motion.span
      className="signal-glow absolute top-2 right-2 flex flex-col items-center rounded-full bg-[var(--signal)] px-2.5 py-1.5 text-[var(--ink)]"
      initial={reduceMotion ? undefined : { opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduceMotion ? undefined : { delay: SCORE_DELAY - 0.1, duration: 0.4, ease: "easeOut" }}
    >
      <span className="font-display text-lg leading-none font-extrabold tabular-nums">
        {score}
      </span>
      <span className="font-mono-data text-[8px] leading-none tracking-wide">
        SCORE
      </span>
    </motion.span>
  );
}

function EvidenceRow({
  marker,
  value,
  time,
  index,
  reduceMotion,
  isVerdict,
}: {
  marker: string;
  value: string;
  time: string;
  index: number;
  reduceMotion: boolean;
  isVerdict?: boolean;
}) {
  const delay = isVerdict ? VERDICT_DELAY : ROW_START + index * ROW_GAP;

  return (
    <motion.div
      className="relative flex items-baseline justify-between gap-3 overflow-hidden border-t border-[var(--line)] py-2 first:border-t-0"
      initial={reduceMotion ? undefined : isVerdict ? { opacity: 0, scale: 0.85 } : { opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={
        reduceMotion
          ? undefined
          : isVerdict
            ? { delay, type: "spring", bounce: 0.45, visualDuration: 0.4 }
            : { delay, duration: 0.35, ease: [0.16, 1, 0.3, 1] as const }
      }
    >
      {!reduceMotion && (
        <motion.span
          aria-hidden
          className="absolute inset-0 bg-[var(--signal)]/15"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.9, 0] }}
          transition={{ delay: delay + 0.05, duration: 0.5, ease: "easeOut" }}
        />
      )}
      <dt className="flex items-baseline gap-1.5 text-[var(--muted)]">
        <span className="text-[var(--signal)]">▸</span>
        {marker}
      </dt>
      <dd
        className={`truncate text-right ${isVerdict ? "font-medium text-[var(--signal)]" : "text-[var(--text)]"}`}
      >
        {value}
        {time && <span className="ml-2 text-[var(--muted)]">{time}</span>}
      </dd>
    </motion.div>
  );
}

function AnimatedCard({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.div
      className="signal-glow relative mx-auto w-full max-w-[320px] rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5"
      initial={reduceMotion ? undefined : { opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const }}
    >
      <div className="flex justify-center">
        {/* mock vertical clip thumbnail — centered so the preview sits
            symmetrically in the card, not shoved against the right border */}
        <div className="relative aspect-9/16 w-full max-w-[248px] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--ink)]">
          {/* real Peakcut output — the actual clips the pipeline shipped, on loop */}
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

          {/* seat the instrument UI over the footage */}
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_58%,rgba(0,0,0,0.55)_100%)]"
          />

          {/* timeline ticks on the left edge — the signal motif */}
          <div aria-hidden className="absolute inset-y-3 left-2 z-10 flex flex-col justify-between">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-px w-2 bg-white/40" />
            ))}
          </div>

          {/* continuous analysis pass — the crew "reading" the clip: a soft amber
              band trailing a bright scan line, sweeping top-to-bottom forever */}
          {!reduceMotion && (
            <>
              <motion.div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-[var(--signal)]/25 to-transparent"
                initial={{ top: "-20%" }}
                animate={{ top: ["-20%", "112%"] }}
                transition={{ duration: 2.8, repeat: Infinity, repeatDelay: 0.5, ease: "easeInOut" }}
              />
              <motion.div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 h-px bg-[var(--signal)] shadow-[0_0_12px_2px_var(--signal)]"
                initial={{ top: "-20%" }}
                animate={{ top: ["-20%", "112%"] }}
                transition={{ duration: 2.8, repeat: Infinity, repeatDelay: 0.5, ease: "easeInOut" }}
              />
            </>
          )}

          <ScoreBadge reduceMotion={reduceMotion} />
        </div>
      </div>

      <dl className="mt-3 font-mono-data text-xs">
        {EVIDENCE_ROWS.map((row, i) => (
          <EvidenceRow key={row.marker} {...row} index={i} reduceMotion={reduceMotion} />
        ))}
        <EvidenceRow {...VERDICT_ROW} index={EVIDENCE_ROWS.length} reduceMotion={reduceMotion} isVerdict />
      </dl>
    </motion.div>
  );
}

/** The signature hero animation: the clip-receipt card builds itself live —
 * scan line sweep, evidence rows streaming in, score counting up, verdict
 * stamping in. Replays each time it scrolls back into view. */
export function ClipReceiptCard() {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.6, once: false });
  const wasInView = useRef(false);
  const [playKey, setPlayKey] = useState(0);

  useEffect(() => {
    if (inView && !wasInView.current) {
      setPlayKey((k) => k + 1);
    }
    wasInView.current = inView;
  }, [inView]);

  return (
    <div ref={ref} className="relative">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(245,179,1,0.14),transparent_65%)] blur-2xl"
      />
      <AnimatedCard key={reduceMotion ? "static" : playKey} reduceMotion={!!reduceMotion} />
    </div>
  );
}
