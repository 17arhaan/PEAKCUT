import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="landing relative flex min-h-full flex-1 flex-col items-center justify-center overflow-hidden bg-[var(--ink)] px-6 py-16 text-center font-body text-[var(--text)]">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-10%] h-[440px] w-[620px] -translate-x-1/2 rounded-full bg-[var(--signal)] opacity-[0.08] blur-[130px]" />
        <div className="absolute bottom-[-16%] right-[6%] h-[360px] w-[420px] rounded-full bg-[var(--pulse)] opacity-[0.08] blur-[130px]" />
      </div>

      <Link href="/" aria-label="Peakcut" className="mb-10">
        <Image src="/peakcut-logo.png" alt="Peakcut" width={1481} height={267} priority className="h-7 w-auto" />
      </Link>

      <span className="font-mono-data text-[11px] tracking-[0.2em] text-[var(--signal)]">
        404 · NO SIGNAL
      </span>
      <h1 className="mt-3 font-display text-5xl font-extrabold tracking-tight sm:text-6xl">
        This page slipped the cut.
      </h1>
      <p className="mt-4 max-w-md text-sm text-[var(--muted)]">
        The link points to a moment that isn&apos;t here — it may have been moved, or never made
        the final render.
      </p>

      <div className="mt-8 flex items-center gap-3">
        <Button
          render={<Link href="/dashboard" />}
          className="signal-glow bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all hover:-translate-y-0.5 hover:bg-[color-mix(in_oklab,var(--signal)_92%,var(--text))]"
        >
          Back to dashboard
        </Button>
        <Button
          render={<Link href="/" />}
          variant="ghost"
          className="border border-[var(--line)] text-[var(--text)] hover:bg-[var(--panel)]"
        >
          Home
        </Button>
      </div>
    </div>
  );
}
