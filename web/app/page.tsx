import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const EVIDENCE_ROWS = [
  { marker: "energy spike", value: "+2.1σ", time: "00:14" },
  { marker: "laughter", value: "", time: "00:45" },
  { marker: "quote", value: '"...you won\'t believe"', time: "" },
  { marker: "verdict", value: "KEEP · hook ✓", time: "", isVerdict: true },
];

const STEPS = [
  {
    index: "01",
    title: "Ingest",
    body: "Paste a YouTube URL or upload the raw file. We pull audio, video, and a transcript.",
  },
  {
    index: "02",
    title: "Measure signals",
    body: "Audio energy, laughter, speech-rate, scene cuts, and faces — scored second by second.",
  },
  {
    index: "03",
    title: "Agent crew debates",
    body: "Scout finds candidate moments, Critic scores them against the signals, Surgeon trims the cut.",
  },
  {
    index: "04",
    title: "Render + QA",
    body: "Hook Writer titles the clip, a final pass checks the cut, and it ships with its receipts.",
  },
];

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "/mo",
    features: [
      "60 minutes of video / month",
      "3 caption styles",
      "Watermark on exports",
      "Your first clips today",
    ],
    cta: "Start free",
  },
  {
    name: "Creator",
    price: "$19",
    period: "/mo",
    features: [
      "300 minutes / month",
      "No watermark",
      "All styles + face-aware crop",
      "Caption restyle",
      "Priority queue",
    ],
    cta: "Start free",
    highlighted: true,
  },
  {
    name: "Pro",
    price: "$49",
    period: "/mo",
    features: [
      "1,200 minutes / month",
      "Everything in Creator",
      "API access",
      "Bulk upload",
      "Team seats",
    ],
    cta: "Start free",
  },
];

function EvidenceReadout({ className }: { className?: string }) {
  return (
    <dl
      className={`font-[family-name:var(--font-plex-mono)] text-xs ${className ?? ""}`}
    >
      {EVIDENCE_ROWS.map((row) => (
        <div
          key={row.marker}
          className="flex items-baseline justify-between gap-3 border-t border-[var(--line)] py-2 first:border-t-0"
        >
          <dt className="flex items-baseline gap-1.5 text-[var(--muted)]">
            <span className="text-[var(--signal)]">▸</span>
            {row.marker}
          </dt>
          <dd
            className={`truncate text-right ${
              row.isVerdict ? "font-medium text-[var(--signal)]" : "text-[var(--text)]"
            }`}
          >
            {row.value}
            {row.time && (
              <span className="ml-2 text-[var(--muted)]">{row.time}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ClipReceiptCard() {
  return (
    <div className="landing-fade-in relative mx-auto w-full max-w-[320px] rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 shadow-2xl shadow-black/40">
      <div className="flex gap-3">
        {/* timestamp ticks along the left edge — the signal motif */}
        <div
          aria-hidden
          className="flex w-8 shrink-0 flex-col justify-between py-1 font-[family-name:var(--font-plex-mono)] text-[9px] text-[var(--muted)]"
        >
          {["00:00", "00:15", "00:30", "00:45"].map((t) => (
            <div key={t} className="flex items-center gap-1">
              <span className="h-px w-2 bg-[var(--line)]" />
              {t}
            </div>
          ))}
        </div>

        {/* mock vertical clip thumbnail */}
        <div className="relative aspect-9/16 flex-1 overflow-hidden rounded-lg border border-[var(--line)] bg-gradient-to-b from-[var(--pulse)]/25 via-[var(--panel)] to-[var(--ink)]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(124,92,255,0.25),transparent_55%)]" />
          <span className="absolute top-2 right-2 flex flex-col items-center rounded-full bg-[var(--signal)] px-2.5 py-1.5 text-[var(--ink)] shadow-lg shadow-black/30">
            <span className="font-[family-name:var(--font-archivo)] text-lg leading-none font-extrabold">
              87
            </span>
            <span className="font-[family-name:var(--font-plex-mono)] text-[8px] leading-none tracking-wide">
              SCORE
            </span>
          </span>
          <p className="absolute inset-x-2 bottom-2 line-clamp-2 rounded bg-black/40 px-1.5 py-1 text-[11px] leading-tight font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
            &ldquo;...you won&rsquo;t believe what happened next&rdquo;
          </p>
        </div>
      </div>

      <EvidenceReadout className="mt-3" />
    </div>
  );
}

export default function Home() {
  return (
    <div className="landing flex flex-1 flex-col bg-[var(--ink)] font-[family-name:var(--font-inter)] text-[var(--text)]">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
          <span className="font-[family-name:var(--font-archivo)] text-sm font-extrabold tracking-tight">
            Shorts Factory
          </span>
          <nav className="hidden items-center gap-6 font-[family-name:var(--font-plex-mono)] text-xs text-[var(--muted)] sm:flex">
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

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-20 md:grid-cols-2 md:items-center md:py-28">
          <div className="landing-fade-in flex flex-col items-start gap-5 text-left">
            <span className="font-[family-name:var(--font-plex-mono)] text-xs font-medium tracking-[0.15em] text-[var(--signal)]">
              SIGNAL-DRIVEN CLIP ENGINE
            </span>
            <h1 className="font-[family-name:var(--font-archivo)] text-4xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-5xl">
              Long video in. Clips that prove themselves out.
            </h1>
            <p className="max-w-md text-lg text-[var(--muted)] text-balance">
              An agent crew scores every moment against measured signals —
              energy, laughter, speech-rate, cuts — and ships each clip with
              the evidence behind its score.
            </p>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <Button
                size="lg"
                render={<Link href="/signin" />}
                className="bg-[var(--signal)] font-semibold text-[var(--ink)] hover:bg-[var(--signal)]/90"
              >
                Start free — 60 minutes
              </Button>
              <Button
                size="lg"
                variant="ghost"
                render={<Link href="#how-it-works" />}
                className="text-[var(--text)] hover:bg-[var(--panel)]"
              >
                See how it works
                <ArrowRight className="size-4" />
              </Button>
            </div>
            <p className="font-[family-name:var(--font-plex-mono)] text-xs text-[var(--muted)]">
              No card. ~$0.12 a video in compute.
            </p>
          </div>

          <ClipReceiptCard />
        </section>

        {/* Signal divider */}
        <div aria-hidden className="mx-auto w-full max-w-6xl px-6">
          <svg
            viewBox="0 0 800 24"
            preserveAspectRatio="none"
            className="h-6 w-full text-[var(--line)]"
          >
            <line x1="0" y1="12" x2="800" y2="12" stroke="currentColor" strokeWidth="1" />
            {Array.from({ length: 40 }).map((_, i) => {
              const h = [4, 8, 3, 10, 6, 12, 5, 9][i % 8];
              return (
                <line
                  key={i}
                  x1={i * 20 + 4}
                  x2={i * 20 + 4}
                  y1={12 - h / 2}
                  y2={12 + h / 2}
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              );
            })}
          </svg>
        </div>

        {/* How it works */}
        <section id="how-it-works" className="mx-auto w-full max-w-6xl px-6 py-20">
          <h2 className="font-[family-name:var(--font-plex-mono)] text-xs font-medium tracking-[0.15em] text-[var(--muted)]">
            HOW IT WORKS
          </h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <li key={step.index} className="flex flex-col gap-2">
                <span className="font-[family-name:var(--font-plex-mono)] text-sm text-[var(--signal)]">
                  {step.index}
                </span>
                <h3 className="font-[family-name:var(--font-archivo)] text-lg font-bold tracking-tight">
                  {step.title}
                </h3>
                <p className="text-sm text-[var(--muted)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Why it's different */}
        <section className="border-t border-[var(--line)]">
          <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-20 md:grid-cols-2 md:items-center">
            <div className="flex flex-col gap-4">
              <h2 className="font-[family-name:var(--font-archivo)] text-3xl font-extrabold tracking-tight text-balance">
                Every other clip tool is a black box.
              </h2>
              <p className="max-w-md text-[var(--muted)]">
                They hand you a score with no explanation. We cite the
                measured signals behind it — the exact energy spike, the
                laugh, the quote — so you can trust the pick or overrule it
                in one look.
              </p>
              <div className="mt-2 flex flex-col gap-3 font-[family-name:var(--font-plex-mono)] text-sm">
                <div className="flex items-center gap-2 text-[var(--muted)] line-through decoration-[var(--line)]">
                  <span>score: 84</span>
                  <span className="text-xs">— black box</span>
                </div>
                <div className="flex items-center gap-2 text-[var(--text)]">
                  <span className="text-[var(--signal)]">score: 87</span>
                  <span className="text-xs text-[var(--muted)]">
                    — cited: energy +2.1σ, laughter, quote
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5">
              <span className="font-[family-name:var(--font-plex-mono)] text-[10px] tracking-[0.15em] text-[var(--muted)]">
                EVIDENCE LOG · CLIP 04
              </span>
              <EvidenceReadout className="mt-2" />
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="border-t border-[var(--line)]">
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <h2 className="font-[family-name:var(--font-archivo)] text-3xl font-extrabold tracking-tight">
              Pricing
            </h2>
            <p className="mt-2 max-w-md text-[var(--muted)]">
              Pay for minutes processed, not seats. Cancel anytime.
            </p>
            <div className="mt-10 grid gap-6 sm:grid-cols-3">
              {TIERS.map((tier) => (
                <div
                  key={tier.name}
                  className={`flex flex-col rounded-2xl border p-6 ${
                    tier.highlighted
                      ? "border-[var(--signal)] bg-[var(--panel)] shadow-lg shadow-[var(--signal)]/5 sm:-translate-y-2"
                      : "border-[var(--line)] bg-[var(--panel)]/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-[family-name:var(--font-archivo)] text-base font-bold">
                      {tier.name}
                    </h3>
                    {tier.highlighted && (
                      <span className="rounded-full bg-[var(--signal)] px-2 py-0.5 font-[family-name:var(--font-plex-mono)] text-[10px] font-medium text-[var(--ink)]">
                        Most popular
                      </span>
                    )}
                  </div>
                  <p className="mt-3 font-[family-name:var(--font-archivo)] text-3xl font-extrabold tracking-tight">
                    {tier.price}
                    <span className="font-[family-name:var(--font-plex-mono)] text-sm font-normal text-[var(--muted)]">
                      {" "}
                      {tier.period}
                    </span>
                  </p>
                  <ul className="mt-6 flex flex-1 flex-col gap-2 text-sm text-[var(--muted)]">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex gap-2">
                        <span className="text-[var(--signal)]">▸</span>
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button
                    className={`mt-6 w-full ${
                      tier.highlighted
                        ? "bg-[var(--signal)] font-semibold text-[var(--ink)] hover:bg-[var(--signal)]/90"
                        : "border border-[var(--line)] bg-transparent text-[var(--text)] hover:bg-[var(--line)]/50"
                    }`}
                    render={<Link href="/signin" />}
                  >
                    {tier.cta}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-2 px-6 py-8 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex flex-col gap-1">
            <span className="font-[family-name:var(--font-archivo)] text-sm font-bold">
              Shorts Factory
            </span>
            <span className="font-[family-name:var(--font-plex-mono)] text-xs text-[var(--muted)]">
              Every clip ships with its receipts.
            </span>
          </div>
          <nav className="flex items-center gap-5 font-[family-name:var(--font-plex-mono)] text-xs text-[var(--muted)]">
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
