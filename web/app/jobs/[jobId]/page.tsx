import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getJobStatusForOwner } from "@/lib/job-status";
import { JobLive } from "./JobLive";

export default async function JobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  const { jobId } = await params;
  const initialData = await getJobStatusForOwner(jobId, userId);
  if (!initialData) notFound();

  return (
    <div className="landing dark peakcut-app flex min-h-full flex-1 flex-col bg-[var(--ink)] font-body text-[var(--text)]">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/dashboard" aria-label="Peakcut" className="flex items-center">
            <Image src="/peakcut-logo.png" alt="Peakcut" width={1481} height={267} priority className="h-5 w-auto" />
          </Link>
          <Link
            href="/dashboard"
            className="font-mono-data text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            ← Dashboard
          </Link>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6 sm:py-10">
        <JobLive jobId={jobId} initialData={initialData} />
      </div>
    </div>
  );
}
