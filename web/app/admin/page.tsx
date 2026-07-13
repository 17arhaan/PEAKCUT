import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/admin";
import {
  getAdminOverview,
  getRecentFailures,
  getRecentJobs,
  getRecentSignups,
  type AdminFailureRow,
  type AdminJobRow,
} from "@/lib/admin-data";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JobStatusBadge } from "@/components/job-status-badge";
import { formatRelativeTime } from "@/lib/utils";
import { Reveal, StatsGrid, type StatConfig } from "./_components/animated";

const RECENT_NOTE = "capped at 25, newest first";
// shared instrument-panel table skin
const TABLE_WRAP = "overflow-hidden rounded-xl border bg-card/50";
const TH = "font-mono-data text-[10px] tracking-[0.12em] uppercase";
const TR = "transition-colors hover:bg-card";

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function jobSource(job: Pick<AdminJobRow | AdminFailureRow, "sourceType" | "sourceUrl">): string {
  if (job.sourceType === "upload") return "Upload";
  if (!job.sourceUrl) return "—";
  return job.sourceUrl.length > 40 ? `${job.sourceUrl.slice(0, 40)}…` : job.sourceUrl;
}

export default async function AdminPage() {
  const session = await auth();
  // Defense in depth: proxy.ts already gates /admin, but this component
  // (and every admin-data.ts query below) re-checks independently and never
  // trusts the proxy alone. Same 404 (not a redirect) as the proxy gate, so
  // a non-admin who somehow reaches this render still can't tell the route
  // exists or apart from a genuinely missing page.
  if (!isAdmin(session)) notFound();

  const [overview, recentJobs, recentSignups, recentFailures] = await Promise.all([
    getAdminOverview(),
    getRecentJobs(),
    getRecentSignups(),
    getRecentFailures(),
  ]);

  const stats: StatConfig[] = [
    { key: "users", label: "Total users", value: overview.totalUsers, sub: `+${overview.signupsLast7Days} last 7d` },
    {
      key: "jobs",
      label: "Total jobs",
      value: overview.totalJobs,
      sub: `${overview.jobsByStatus.queued} queued · ${overview.jobsByStatus.processing} processing · ${overview.jobsByStatus.done} done · ${overview.jobsByStatus.failed} failed`,
    },
    {
      key: "videos",
      label: "Videos processed",
      value: overview.totalVideosProcessed,
      sub: `${overview.totalClips} clips produced`,
    },
    {
      key: "cost",
      label: "Compute/LLM cost",
      value: overview.totalCostCents / 100,
      decimals: 2,
      prefix: "$",
      sub: `${centsToDollars(overview.costCentsLast7Days)} last 7d`,
    },
    {
      key: "credits",
      label: "Credits outstanding",
      value: overview.creditsOutstandingMinutes,
      suffix: " min",
      sub: `${overview.minutesGranted} granted · ${overview.minutesSpent} spent`,
    },
    {
      key: "revenue",
      label: "Revenue",
      value: overview.revenueCents / 100,
      decimals: 2,
      prefix: "$",
      sub: `${overview.payingUsers} paying users`,
      glow: true,
    },
  ];

  return (
    <div className="dark admin-cockpit min-h-full flex-1 bg-background font-body text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        <Reveal>
          <span className="font-mono-data text-[11px] tracking-[0.15em] text-primary">
            COCKPIT
          </span>
          <div className="mt-1 flex items-center gap-2.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
            />
            <h1 className="font-display text-2xl font-extrabold tracking-tight">Admin</h1>
          </div>
          <p className="mt-1 font-mono-data text-xs text-muted-foreground">
            Cross-user monitoring cockpit — read-only. Visible only to {session?.user?.email}.
          </p>
        </Reveal>

        <StatsGrid stats={stats} />

        {/* admin actions (grant credits, delete user) — future */}

        <Reveal>
          <section className="flex flex-col gap-2">
            <h2 className="font-display text-sm font-bold">
              Recent jobs <span className="font-mono-data font-normal text-muted-foreground">({RECENT_NOTE})</span>
            </h2>
            <div className={TABLE_WRAP}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={TH}>User</TableHead>
                    <TableHead className={TH}>Source</TableHead>
                    <TableHead className={TH}>Status</TableHead>
                    <TableHead className={TH}>Duration</TableHead>
                    <TableHead className={TH}>Cost</TableHead>
                    <TableHead className={TH}>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentJobs.map((job) => (
                    // No link to /jobs/[id]: that route's owner-guard 404s a job
                    // that isn't the viewer's, and admins aren't an exception to
                    // it (see lib/job-status.ts). Rather than widen that
                    // ownership check's trust boundary for this read-only
                    // cockpit, this row is data-only — see web-admin-report.md.
                    <TableRow key={job.id} className={TR}>
                      <TableCell className="text-muted-foreground">{job.userEmail}</TableCell>
                      <TableCell>{jobSource(job)}</TableCell>
                      <TableCell>
                        <JobStatusBadge status={job.status} />
                      </TableCell>
                      <TableCell className="font-mono-data tabular-nums text-muted-foreground">{job.durationMin != null ? `${job.durationMin.toFixed(1)} min` : "—"}</TableCell>
                      <TableCell className="font-mono-data tabular-nums text-muted-foreground">{job.costCents != null ? centsToDollars(job.costCents) : "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatRelativeTime(job.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </Reveal>

        <Reveal>
          <section className="flex flex-col gap-2">
            <h2 className="font-display text-sm font-bold">
              Recent signups <span className="font-mono-data font-normal text-muted-foreground">({RECENT_NOTE})</span>
            </h2>
            <div className={TABLE_WRAP}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={TH}>Email</TableHead>
                    <TableHead className={TH}>Plan</TableHead>
                    <TableHead className={TH}>Balance</TableHead>
                    <TableHead className={TH}>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentSignups.map((u) => (
                    <TableRow key={u.id} className={TR}>
                      <TableCell>{u.email}</TableCell>
                      <TableCell className="text-muted-foreground">{u.plan}</TableCell>
                      <TableCell className="font-mono-data tabular-nums text-muted-foreground">{u.minutesBalance} min</TableCell>
                      <TableCell className="text-muted-foreground">{formatRelativeTime(u.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </Reveal>

        <Reveal>
          <section className="flex flex-col gap-2">
            <h2 className="font-display text-sm font-bold">
              Recent failures <span className="font-mono-data font-normal text-muted-foreground">({RECENT_NOTE})</span>
            </h2>
            <div className={TABLE_WRAP}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={TH}>User</TableHead>
                    <TableHead className={TH}>Source</TableHead>
                    <TableHead className={TH}>Error</TableHead>
                    <TableHead className={TH}>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentFailures.map((job) => (
                    <TableRow key={job.id} className={TR}>
                      <TableCell className="text-muted-foreground">{job.userEmail}</TableCell>
                      <TableCell>{jobSource(job)}</TableCell>
                      <TableCell className="text-destructive">{job.error ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatRelativeTime(job.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </Reveal>
      </div>
    </div>
  );
}
