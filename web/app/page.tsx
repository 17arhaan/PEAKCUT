import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AmbientTrace } from "./_components/landing/ambient-trace";
import { HeroSection } from "./_components/landing/hero-section";
import { TrustStrip } from "./_components/landing/trust-strip";
import { Features } from "./_components/landing/features";
import { HowItWorks } from "./_components/landing/how-it-works";
import { Demo } from "./_components/landing/demo";
import { Faq } from "./_components/landing/faq";
import { Pricing } from "./_components/landing/pricing";

export default function Home() {
  return (
    <div className="landing flex flex-1 flex-col bg-[var(--ink)] font-body text-[var(--text)]">
      <div className="landing-grain" />

      <header className="relative z-10 border-b border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
          <span className="font-display text-sm font-extrabold tracking-tight">
            Peakcut
          </span>
          <nav className="hidden items-center gap-6 font-mono-data text-xs text-[var(--muted)] sm:flex">
            <a href="#how-it-works" className="transition-colors hover:text-[var(--text)]">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-[var(--text)]">
              Pricing
            </a>
          </nav>
          <Button
            size="sm"
            render={<Link href="/signin" />}
            className="border border-[var(--line)] bg-transparent text-[var(--text)] hover:bg-[var(--panel)]"
          >
            Sign in
          </Button>
        </div>
      </header>

      <main className="relative z-10 flex-1">
        <HeroSection />

        <div aria-hidden className="mx-auto w-full max-w-6xl px-6">
          <AmbientTrace className="h-10 w-full" />
        </div>

        <TrustStrip />
        <Features />
        <HowItWorks />
        <Demo />
        <Faq />
        <Pricing />
      </main>

      <footer className="relative z-10 border-t border-[var(--line)] bg-[color-mix(in_oklab,var(--panel)_45%,transparent)]">
        {/* thin signal accent along the top edge */}
        <div aria-hidden className="h-px w-full bg-gradient-to-r from-transparent via-[var(--signal)]/40 to-transparent" />
        <div className="mx-auto w-full max-w-6xl px-6 py-12">
          <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
            <div className="flex max-w-xs flex-col gap-3">
              <span className="font-display text-base font-extrabold tracking-tight">
                Peakcut
              </span>
              <p className="text-sm text-[var(--muted)]">
                An agent crew scores every moment against measured signals — and
                ships each clip with the evidence behind its score.
              </p>
              <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--signal)]">
                SIGNAL-DRIVEN CLIP ENGINE
              </span>
            </div>

            <div className="grid grid-cols-2 gap-10 sm:gap-20">
              <div className="flex flex-col gap-3">
                <span className="font-mono-data text-[11px] tracking-wide text-[var(--muted)] uppercase">
                  Product
                </span>
                <a href="#how-it-works" className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]">
                  How it works
                </a>
                <a href="#pricing" className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]">
                  Pricing
                </a>
              </div>
              <div className="flex flex-col gap-3">
                <span className="font-mono-data text-[11px] tracking-wide text-[var(--muted)] uppercase">
                  Account
                </span>
                <Link href="/signin" className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]">
                  Sign in
                </Link>
                <Link href="/dashboard" className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]">
                  Dashboard
                </Link>
              </div>
            </div>
          </div>

          <div className="mt-10 flex flex-col items-start gap-2 border-t border-[var(--line)] pt-6 font-mono-data text-xs text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} Peakcut</span>
            <span>Every clip ships with its receipts.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
