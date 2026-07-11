import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import type { jobs } from "@/lib/db/schema";

type JobStatus = (typeof jobs.$inferSelect)["status"];
type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const STATUS_BADGE: Record<JobStatus, { label: string; variant: BadgeVariant; className?: string }> = {
  queued: { label: "Queued", variant: "secondary" },
  processing: { label: "Processing", variant: "default" },
  done: {
    label: "Done",
    variant: "outline",
    className: "border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400",
  },
  failed: { label: "Failed", variant: "destructive" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const badge = STATUS_BADGE[status] ?? { label: status, variant: "secondary" as const };
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {badge.label}
    </Badge>
  );
}
