"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { EVIDENCE_ROWS, VERDICT_ROW } from "./data";
import { useCountUp } from "./use-count-up";

const BAR_HEIGHTS = [10, 16, 7, 24, 14, 30, 9, 20, 15, 27, 11, 34, 12, 19, 25, 8, 22, 15, 29, 10, 17, 23, 13, 20];

// Timing spine for the orchestrated build (seconds from mount). Evidence
// rows land on a 0.25s stagger starting at ROW_START; the score counts up
// once the last row has landed; the verdict stamps in last.
const ROW_START = 0.55;
const ROW_GAP = 0.25;
const SCORE_DELAY = ROW_START + EVIDENCE_ROWS.length * ROW_GAP + 0.05;
const SCORE_DURATION = 0.9;
const VERDICT_DELAY = SCORE_DELAY + SCORE_DURATION + 0.15;

function Waveform({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <div
      aria-hidden
      className="mx-2 mb-2 flex h-10 items-end gap-[3px] rounded-md border border-white/10 bg-black/35 px-2.5 pb-2 backdrop-blur-sm"
    >
      {BAR_HEIGHTS.map((h, i) => (
        <motion.span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-[var(--signal)]"
          style={{ height: h, transformOrigin: "bottom" }}
          initial={reduceMotion ? undefined : { scaleY: 0.15, opacity: 0.35 }}
          animate={
            reduceMotion
              ? { scaleY: 0.7, opacity: 0.5 }
              : {
                  scaleY: [0.15, 1, 0.55, 0.8, 0.55],
                  opacity: [0.35, 1, 0.6, 0.8, 0.6],
                }
          }
          transition={
            reduceMotion
              ? undefined
              : {
                  duration: 2.4,
                  delay: i * 0.025,
                  times: [0, 0.22, 0.5, 0.75, 1],
                  repeat: Infinity,
                  repeatDelay: 1.6,
                  ease: "easeInOut",
                }
          }
        />
      ))}
    </div>
  );
}

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
      className="signal-glow relative mx-auto w-full max-w-[320px] rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4"
      initial={reduceMotion ? undefined : { opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const }}
    >
      <div className="flex gap-3">
        {/* timestamp ticks along the left edge — the signal motif */}
        <div
          aria-hidden
          className="flex w-8 shrink-0 flex-col justify-between py-1 font-mono-data text-[9px] text-[var(--muted)]"
        >
          {["00:00", "00:15", "00:30", "00:45"].map((t) => (
            <div key={t} className="flex items-center gap-1">
              <span className="h-px w-2 bg-[var(--line)]" />
              {t}
            </div>
          ))}
        </div>

        {/* mock vertical clip thumbnail */}
        <div className="relative aspect-9/16 flex-1 overflow-hidden rounded-lg border border-[var(--line)] bg-gradient-to-b from-[var(--pulse)]/30 via-[var(--panel)] to-[var(--ink)]">
          {/* directional light suggesting a backlit subject, not an empty box */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_22%,rgba(245,179,1,0.22),transparent_42%),radial-gradient(circle_at_65%_55%,rgba(124,92,255,0.3),transparent_55%)]" />
          {/* edge vignette for depth */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.55)_100%)]" />

          {/* timeline grid — extends the left-edge tick marks across the frame so
              the empty space reads as an instrument readout, not a blank box */}
          <div aria-hidden className="absolute inset-0 flex flex-col justify-between py-1 opacity-[0.14]">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-px w-full bg-[var(--line)]" />
            ))}
          </div>

          {/* analysis scan line */}
          {!reduceMotion && (
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 h-12 bg-gradient-to-b from-transparent via-[var(--signal)]/50 to-transparent"
              initial={{ top: "-15%", opacity: 0 }}
              animate={{ top: ["-15%", "105%"], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 1.3, delay: 0.35, times: [0, 0.12, 0.85, 1], ease: "easeInOut" }}
            />
          )}

          <ScoreBadge reduceMotion={reduceMotion} />

          <div className="absolute inset-x-0 bottom-0">
            <Waveform reduceMotion={reduceMotion} />
            <p className="mx-2 mb-2 line-clamp-2 rounded bg-black/40 px-1.5 py-1 text-[11px] leading-tight font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
              &ldquo;...you won&rsquo;t believe what happened next&rdquo;
            </p>
          </div>
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
