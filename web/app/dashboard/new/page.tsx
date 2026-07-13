import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserBalance } from "@/lib/data";
import { NewJobForm } from "./new-job-form";
import { JobPreview } from "./JobPreview";

export default async function NewJobPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  const balance = await getUserBalance(userId);

  // Reuses the landing page's instrument-panel theme (app/globals.css'
  // `.landing` scope) -- this is the product's signature "receipts" moment,
  // so it gets a two-column pitch layout, not a lonely form in a data table.
  return (
    <div className="landing relative flex min-h-full flex-1 flex-col overflow-hidden bg-[var(--ink)] font-body text-[var(--text)]">
      <div className="landing-grain" />
      {/* ambient glows so the space reads as atmosphere, not emptiness */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute top-[-12%] left-[6%] h-[440px] w-[560px] rounded-full bg-[var(--signal)] opacity-[0.08] blur-[140px]" />
        <div className="absolute right-[2%] bottom-[-18%] h-[440px] w-[500px] rounded-full bg-[var(--pulse)] opacity-[0.10] blur-[140px]" />
      </div>

      <div className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
        <div className="flex w-full flex-col gap-7">
          <div className="flex flex-col gap-3">
            <span className="font-mono-data text-xs font-medium tracking-[0.15em] text-[var(--signal)]">
              NEW CLIP JOB
            </span>
            <h1 className="font-display text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
              Drop a video in.{" "}
              <span className="text-gradient-signal">Get clips that prove themselves.</span>
            </h1>
            <p className="max-w-md text-[var(--muted)]">
              Paste a YouTube link or upload a file — an agent crew scores every
              moment against measured signals and ships the evidence behind each clip.
            </p>
          </div>

          <NewJobForm userId={userId} balance={balance} />
        </div>

        <JobPreview />
      </div>
    </div>
  );
}
