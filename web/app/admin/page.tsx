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
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JobStatusBadge } from "@/components/job-status-badge";
import { formatRelativeTime } from "@/lib/utils";

const RECENT_NOTE = "capped at 25, newest first";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="gap-0 px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
        {sub && <CardDescription>{sub}</CardDescription>}
      </CardHeader>
    </Card>
  );
}

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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          Cross-user monitoring cockpit — read-only. Visible only to {session?.user?.email}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="Total users" value={String(overview.totalUsers)} sub={`+${overview.signupsLast7Days} last 7d`} />
        <StatCard
          label="Total jobs"
          value={String(overview.totalJobs)}
          sub={`${overview.jobsByStatus.queued} queued · ${overview.jobsByStatus.processing} processing · ${overview.jobsByStatus.done} done · ${overview.jobsByStatus.failed} failed`}
        />
        <StatCard label="Videos processed" value={String(overview.totalVideosProcessed)} sub={`${overview.totalClips} clips produced`} />
        <StatCard
          label="Compute/LLM cost"
          value={centsToDollars(overview.totalCostCents)}
          sub={`${centsToDollars(overview.costCentsLast7Days)} last 7d`}
        />
        <StatCard
          label="Credits outstanding"
          value={`${overview.creditsOutstandingMinutes} min`}
          sub={`${overview.minutesGranted} granted · ${overview.minutesSpent} spent`}
        />
        <StatCard label="Revenue" value={centsToDollars(overview.revenueCents)} sub={`${overview.payingUsers} paying users`} />
      </div>

      {/* admin actions (grant credits, delete user) — future */}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Recent jobs <span className="font-normal text-muted-foreground">({RECENT_NOTE})</span></h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentJobs.map((job) => (
              // No link to /jobs/[id]: that route's owner-guard 404s a job
              // that isn't the viewer's, and admins aren't an exception to
              // it (see lib/job-status.ts). Rather than widen that
              // ownership check's trust boundary for this read-only
              // cockpit, this row is data-only — see web-admin-report.md.
              <TableRow key={job.id}>
                <TableCell className="text-muted-foreground">{job.userEmail}</TableCell>
                <TableCell>{jobSource(job)}</TableCell>
                <TableCell>
                  <JobStatusBadge status={job.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{job.durationMin != null ? `${job.durationMin.toFixed(1)} min` : "—"}</TableCell>
                <TableCell className="text-muted-foreground">{job.costCents != null ? centsToDollars(job.costCents) : "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatRelativeTime(job.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Recent signups <span className="font-normal text-muted-foreground">({RECENT_NOTE})</span></h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentSignups.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}</TableCell>
                <TableCell className="text-muted-foreground">{u.plan}</TableCell>
                <TableCell className="text-muted-foreground">{u.minutesBalance} min</TableCell>
                <TableCell className="text-muted-foreground">{formatRelativeTime(u.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Recent failures <span className="font-normal text-muted-foreground">({RECENT_NOTE})</span></h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentFailures.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="text-muted-foreground">{job.userEmail}</TableCell>
                <TableCell>{jobSource(job)}</TableCell>
                <TableCell className="text-destructive">{job.error ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatRelativeTime(job.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
