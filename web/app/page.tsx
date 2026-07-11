import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const STEPS = [
  {
    title: "Paste or upload",
    body: "Drop in a YouTube URL or upload your own long-form video.",
  },
  {
    title: "Agents work the footage",
    body: "Scout, score, and edit agents find the moments worth clipping — live, so you can watch it happen.",
  },
  {
    title: "Review clips, with receipts",
    body: "Every clip ships with a score and the evidence behind it. Download the ones you want.",
  },
];

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "trial",
    description: "60 minutes of processing to try the pipeline.",
    features: ["60 min one-time trial", "Full agent pipeline", "Scored clips with evidence"],
    cta: "Start free",
  },
  {
    name: "Creator",
    price: "~$15",
    period: "/mo",
    description: "For creators publishing clips every week.",
    features: ["Monthly processing minutes", "Priority queue", "Credit top-ups"],
    cta: "Get started",
    highlighted: true,
  },
  {
    name: "Pro",
    price: "~$30",
    period: "/mo",
    description: "For agencies and teams repurposing at volume.",
    features: ["More monthly minutes", "Priority queue", "Credit top-ups"],
    cta: "Get started",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
          <span className="text-sm font-semibold tracking-tight">Shorts Factory</span>
          <Button size="sm" render={<Link href="/signin" />}>
            Sign in
          </Button>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-6 px-6 py-24 text-center">
          <Badge variant="secondary">Placeholder — early build</Badge>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Shorts Factory
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground text-balance">
            Long video in. Viral clips out — with receipts.
          </p>
          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            <Button size="lg" render={<Link href="/signin" />}>
              Start free
            </Button>
            <Button size="lg" variant="outline" render={<Link href="/signin" />}>
              Sign in
            </Button>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t bg-muted/30">
          <div className="mx-auto w-full max-w-5xl px-6 py-20">
            <h2 className="text-center text-2xl font-semibold tracking-tight">
              How it works
            </h2>
            <ol className="mt-12 grid gap-8 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex flex-col items-start gap-2">
                  <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
                    {i + 1}
                  </span>
                  <h3 className="font-medium">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Pricing */}
        <section className="border-t">
          <div className="mx-auto w-full max-w-5xl px-6 py-20">
            <h2 className="text-center text-2xl font-semibold tracking-tight">
              Pricing
            </h2>
            <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
              Placeholder numbers — final pricing lands before launch.
            </p>
            <div className="mt-12 grid gap-6 sm:grid-cols-3">
              {TIERS.map((tier) => (
                <Card
                  key={tier.name}
                  className={tier.highlighted ? "ring-2 ring-primary" : undefined}
                >
                  <CardHeader>
                    <CardTitle className="text-base font-semibold">{tier.name}</CardTitle>
                    <CardDescription>{tier.description}</CardDescription>
                    <p className="pt-2 text-3xl font-semibold tracking-tight">
                      {tier.price}
                      <span className="text-sm font-normal text-muted-foreground">
                        {" "}
                        {tier.period}
                      </span>
                    </p>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {tier.features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <Button
                      className="w-full"
                      variant={tier.highlighted ? "default" : "outline"}
                      render={<Link href="/signin" />}
                    >
                      {tier.cta}
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 text-center text-sm text-muted-foreground">
          Shorts Factory — placeholder name.
        </div>
      </footer>
    </div>
  );
}
