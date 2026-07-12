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

      <footer className="relative z-10 border-t border-[var(--line)] bg-[var(--panel)]/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-2 px-6 py-8 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex flex-col gap-1">
            <span className="font-display text-sm font-bold">
              Peakcut
            </span>
            <span className="font-mono-data text-xs text-[var(--muted)]">
              Every clip ships with its receipts.
            </span>
          </div>
          <nav className="flex items-center gap-5 font-mono-data text-xs text-[var(--muted)]">
            <a href="#how-it-works" className="transition-colors hover:text-[var(--text)]">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-[var(--text)]">
              Pricing
            </a>
            <Link href="/signin" className="transition-colors hover:text-[var(--text)]">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
