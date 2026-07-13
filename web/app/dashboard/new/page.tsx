import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserBalance } from "@/lib/data";
import { NewJobForm } from "./new-job-form";

export default async function NewJobPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  const balance = await getUserBalance(userId);

  // Reuses the landing page's instrument-panel theme (app/globals.css'
  // `.landing` scope) rather than the dashboard's default shadcn theme --
  // this is the one dashboard screen meant to feel like the product's
  // signature "receipts" moment, not a data table.
  return (
    <div className="landing flex flex-col items-center bg-[var(--ink)] px-6 py-12 font-body text-[var(--text)] sm:py-20">
      <div className="landing-grain" />
      <div className="relative z-10 flex w-full max-w-xl flex-col items-center gap-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <span className="font-mono-data text-xs font-medium tracking-[0.15em] text-[var(--signal)]">
            NEW CLIP JOB
          </span>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            Drop in a video. Get clips with receipts.
          </h1>
          <p className="max-w-sm text-sm text-[var(--muted)]">
            Paste a link or upload a file — the crew scores every moment and
            ships the evidence behind each clip.
          </p>
        </div>

        <NewJobForm userId={userId} balance={balance} />
      </div>
    </div>
  );
}
