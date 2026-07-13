import type { jobs } from "@/lib/db/schema";

type JobStatus = (typeof jobs.$inferSelect)["status"];

// Instrument-panel status pill: a colored state dot + label. "Processing" gets
// a live ping so an in-flight job reads as active at a glance. Explicit hues
// (not theme tokens) so it renders identically on every dark surface it appears
// on — dashboard, admin cockpit, and the job page. Pure CSS, no hooks, so it
// stays a server component.
const STATUS: Record<JobStatus, { label: string; dot: string; pill: string; pulse?: boolean }> = {
  queued: {
    label: "Queued",
    dot: "bg-slate-400",
    pill: "border-slate-500/25 bg-slate-500/10 text-slate-300",
  },
  processing: {
    label: "Processing",
    dot: "bg-amber-400",
    pill: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    pulse: true,
  },
  done: {
    label: "Done",
    dot: "bg-emerald-400",
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  failed: {
    label: "Failed",
    dot: "bg-red-400",
    pill: "border-red-500/30 bg-red-500/10 text-red-300",
  },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status] ?? STATUS.queued;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono-data text-[11px] font-medium tracking-wide ${s.pill}`}
    >
      <span className="relative flex size-1.5">
        {s.pulse && (
          <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${s.dot}`} />
        )}
        <span className={`relative inline-flex size-1.5 rounded-full ${s.dot}`} />
      </span>
      {s.label}
    </span>
  );
}
