import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { getJobsForUser, getUserProfile } from "@/lib/data";
import type { jobs as jobsTable } from "@/lib/db/schema";
import { JobsList, type JobRow } from "./_components/jobs-list";

type Job = typeof jobsTable.$inferSelect;

function jobSource(job: Job): string {
  if (job.sourceType === "upload") return "Upload";
  if (!job.sourceUrl) return "—";
  return job.sourceUrl.length > 40 ? `${job.sourceUrl.slice(0, 40)}…` : job.sourceUrl;
}

function jobDurationCost(job: Job): string {
  const parts: string[] = [];
  if (job.durationMin != null) parts.push(`${job.durationMin.toFixed(1)} min`);
  if (job.costCents != null) parts.push(`$${(job.costCents / 100).toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  // Stale-session guard (cookie outlived the user row) -- same as /settings.
  const [userJobs, user] = await Promise.all([getJobsForUser(userId), getUserProfile(userId)]);
  if (!user) redirect("/signin");
  const balance = user.minutesBalance;

  const rows: JobRow[] = userJobs.map((job) => ({
    id: job.id,
    status: job.status,
    source: jobSource(job),
    createdAt: job.createdAt,
    durationCost: jobDurationCost(job),
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--signal)]">
            WORKSPACE
          </span>
          <h1 className="font-display text-2xl font-extrabold tracking-tight">Your jobs</h1>
        </div>

        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--panel)]/60 px-3.5 py-1.5"
            title="Minutes remaining"
          >
            <Sparkles className="size-3.5 text-[var(--signal)]" aria-hidden />
            <span className="font-mono-data text-xs tabular-nums text-[var(--text)]">
              <span className="font-semibold">{balance}</span>
              <span className="text-[var(--muted)]"> min remaining</span>
            </span>
          </div>
          <Button
            render={<Link href="/dashboard/new" />}
            className="signal-glow gap-1.5 bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all hover:-translate-y-0.5 hover:bg-[color-mix(in_oklab,var(--signal)_92%,var(--text))]"
          >
            <Plus className="size-4" aria-hidden />
            New job
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--panel)]/30 px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--signal)]/12 text-[var(--signal)]">
            <Sparkles className="size-6" aria-hidden />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="font-display text-lg font-bold tracking-tight">No jobs yet</h2>
            <p className="max-w-xs text-sm text-[var(--muted)]">
              Paste a YouTube link to get your first clips.
            </p>
          </div>
          <Button
            render={<Link href="/dashboard/new" />}
            className="signal-glow gap-1.5 bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all hover:-translate-y-0.5 hover:bg-[color-mix(in_oklab,var(--signal)_92%,var(--text))]"
          >
            <Plus className="size-4" aria-hidden />
            New job
          </Button>
        </div>
      ) : (
        <JobsList jobs={rows} />
      )}
    </div>
  );
}
