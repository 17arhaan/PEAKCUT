"use client";

import { useEffect, useState } from "react";
import { animate, useReducedMotion } from "motion/react";

/** Animates a number from 0 to `target` once `start` flips true. Respects
 * prefers-reduced-motion by jumping straight to the target. */
export function useCountUp(
  target: number,
  {
    start = true,
    duration = 1.1,
    delay = 0,
    decimals = 0,
  }: { start?: boolean; duration?: number; delay?: number; decimals?: number } = {},
) {
  const reduceMotion = useReducedMotion();
  const [value, setValue] = useState(0);
  const factor = 10 ** decimals;

  useEffect(() => {
    if (!start || reduceMotion) return;
    const controls = animate(0, target, {
      duration,
      delay,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setValue(Math.round(v * factor) / factor),
    });
    return () => controls.stop();
  }, [start, target, duration, delay, reduceMotion, factor]);

  // Reduced motion: skip the animation entirely and render the final value.
  return reduceMotion ? target : value;
}
