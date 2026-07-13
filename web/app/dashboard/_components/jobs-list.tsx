"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Stagger, StaggerItem } from "@/app/_components/motion";
import { JobStatusBadge } from "@/components/job-status-badge";
import { formatRelativeTime } from "@/lib/utils";
import type { JobStatus } from "@/lib/job-status";

export interface JobRow {
  id: string;
  status: JobStatus["status"];
  source: string;
  createdAt: Date;
  durationCost: string;
}

export function JobsList({ jobs }: { jobs: JobRow[] }) {
  return (
    <Stagger className="flex flex-col gap-2.5" amount={0.05}>
      {jobs.map((job) => (
        <StaggerItem key={job.id} hover>
          <Link
            href={`/jobs/${job.id}`}
            className="group flex items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--panel)]/50 px-4 py-3.5 transition-colors duration-200 hover:border-[var(--signal)]/40 hover:bg-[var(--panel)]/80 focus-visible:border-[var(--signal)]/60 focus-visible:outline-none"
          >
            <div className="w-24 shrink-0">
              <JobStatusBadge status={job.status} />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate font-mono-data text-sm text-[var(--text)]">{job.source}</p>
              <p className="mt-0.5 font-mono-data text-[11px] text-[var(--muted)]">
                {formatRelativeTime(job.createdAt)}
              </p>
            </div>

            <span className="hidden shrink-0 font-mono-data text-xs tabular-nums text-[var(--muted)] sm:inline">
              {job.durationCost}
            </span>

            <ArrowRight
              className="size-4 shrink-0 text-[var(--muted)] transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-[var(--signal)]"
              aria-hidden
            />
          </Link>
        </StaggerItem>
      ))}
    </Stagger>
  );
}
