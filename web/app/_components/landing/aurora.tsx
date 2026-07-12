"use client";

import { motion, useReducedMotion } from "motion/react";

// Slow-drifting blurred gradient blobs behind the hero — atmosphere, not a
// focal point. Two colors only (amber + violet, both already in the
// palette), kept faint so it never competes with the amber accents.
const BLOBS = [
  {
    className: "top-[-10%] left-[5%] h-[420px] w-[420px] bg-[var(--signal)]",
    animate: { x: [0, 30, -10, 0], y: [0, -20, 15, 0], opacity: [0.14, 0.2, 0.12, 0.14] },
    duration: 22,
  },
  {
    className: "top-[10%] right-[0%] h-[460px] w-[460px] bg-[var(--pulse)]",
    animate: { x: [0, -25, 15, 0], y: [0, 25, -15, 0], opacity: [0.12, 0.17, 0.1, 0.12] },
    duration: 26,
  },
  {
    className: "bottom-[-15%] left-[30%] h-[360px] w-[360px] bg-[var(--signal)]",
    animate: { x: [0, 18, -22, 0], y: [0, -15, 10, 0], opacity: [0.08, 0.13, 0.07, 0.08] },
    duration: 30,
  },
];

export function Aurora() {
  const reduceMotion = useReducedMotion();

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {BLOBS.map((blob, i) => (
        <motion.div
          key={i}
          className={`absolute rounded-full blur-[110px] ${blob.className}`}
          style={{ opacity: blob.animate.opacity[0] }}
          animate={reduceMotion ? undefined : blob.animate}
          transition={
            reduceMotion
              ? undefined
              : { duration: blob.duration, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }
          }
        />
      ))}
    </div>
  );
}
