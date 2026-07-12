"use client";

import { useSyncExternalStore, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion, useMotionValue, useMotionTemplate } from "motion/react";
import { Button } from "@/components/ui/button";
import { ClipReceiptCard } from "./hero-card";
import { Aurora } from "./aurora";

const HEADLINE_WORDS = ["Long", "video", "in.", "Clips", "that", "prove", "themselves", "out."];
const GRADIENT_WORD = "prove";

const headlineContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } },
};

const wordVariant = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: [0.16, 1, 0.3, 1] as const } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } },
};

function subscribeFinePointer(callback: () => void) {
  const mql = window.matchMedia("(pointer: fine)");
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}
const getFinePointer = () => window.matchMedia("(pointer: fine)").matches;
const getFinePointerServer = () => false;

/** Soft amber glow that follows the cursor within the hero — mouse only,
 * disabled under prefers-reduced-motion. */
function useCursorSpotlight(disabled: boolean) {
  const hasFinePointer = useSyncExternalStore(subscribeFinePointer, getFinePointer, getFinePointerServer);
  const enabled = hasFinePointer && !disabled;
  const x = useMotionValue(-500);
  const y = useMotionValue(-500);
  const background = useMotionTemplate`radial-gradient(480px circle at ${x}px ${y}px, rgba(245,179,1,0.14), transparent 70%)`;

  function onPointerMove(e: PointerEvent<HTMLElement>) {
    if (disabled || e.pointerType !== "mouse") return;
    const rect = e.currentTarget.getBoundingClientRect();
    x.set(e.clientX - rect.left);
    y.set(e.clientY - rect.top);
  }

  return { enabled, background, onPointerMove };
}

export function HeroSection() {
  const reduceMotion = !!useReducedMotion();
  const spotlight = useCursorSpotlight(reduceMotion);

  return (
    <section
      onPointerMove={spotlight.onPointerMove}
      className="relative mx-auto grid w-full max-w-6xl gap-12 overflow-hidden px-6 py-20 md:grid-cols-2 md:items-center md:py-28"
    >
      <Aurora />
      {spotlight.enabled && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: spotlight.background }}
        />
      )}

      <motion.div
        className="flex flex-col items-start gap-5 text-left"
        initial={reduceMotion ? undefined : "hidden"}
        animate="visible"
        variants={reduceMotion ? undefined : headlineContainer}
      >
        <motion.span
          variants={reduceMotion ? undefined : fadeUp}
          className="font-mono-data text-xs font-medium tracking-[0.15em] text-[var(--signal)]"
        >
          SIGNAL-DRIVEN CLIP ENGINE
        </motion.span>

        <motion.h1
          variants={reduceMotion ? undefined : headlineContainer}
          className="font-display text-4xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-5xl"
        >
          {HEADLINE_WORDS.flatMap((word, i) => [
            <motion.span key={`w-${i}`} variants={reduceMotion ? undefined : wordVariant} className="inline-block">
              <span className={word === GRADIENT_WORD ? "text-gradient-signal" : undefined}>{word}</span>
            </motion.span>,
            i < HEADLINE_WORDS.length - 1 ? " " : null,
          ])}
        </motion.h1>

        <motion.p
          variants={reduceMotion ? undefined : fadeUp}
          className="max-w-md text-lg text-[var(--muted)] text-balance"
        >
          An agent crew scores every moment against measured signals —
          energy, laughter, speech-rate, cuts — and ships each clip with
          the evidence behind its score.
        </motion.p>

        <motion.div variants={reduceMotion ? undefined : fadeUp} className="flex flex-col gap-3 pt-2 sm:flex-row">
          <Button
            size="lg"
            render={<Link href="/signin" />}
            className="signal-glow bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--signal)]/90 hover:shadow-[0_16px_40px_-10px_rgba(245,179,1,0.55)]"
          >
            Start free — 60 minutes
          </Button>
          <Button
            size="lg"
            variant="ghost"
            render={<Link href="#how-it-works" />}
            className="text-[var(--text)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--panel)]"
          >
            See how it works
            <ArrowRight className="size-4" />
          </Button>
        </motion.div>

        <motion.p
          variants={reduceMotion ? undefined : fadeUp}
          className="font-mono-data text-xs text-[var(--muted)]"
        >
          No card. ~$0.12 a video in compute.
        </motion.p>
      </motion.div>

      <ClipReceiptCard />
    </section>
  );
}
