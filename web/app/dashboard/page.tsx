import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { JobStatusBadge } from "@/components/job-status-badge";
import { getJobsForUser, getUserBalance } from "@/lib/data";
import type { jobs as jobsTable } from "@/lib/db/schema";
import { formatRelativeTime } from "@/lib/utils";

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

  const [userJobs, balance] = await Promise.all([getJobsForUser(userId), getUserBalance(userId)]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{balance}</span> minutes remaining
        </p>
        <Button size="sm" render={<Link href="/dashboard/new" />}>
          New job
        </Button>
      </div>

      {userJobs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No jobs yet</CardTitle>
            <CardDescription>Paste a YouTube link to get your first clips.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button render={<Link href="/dashboard/new" />}>New job</Button>
          </CardFooter>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Duration / cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {userJobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Link href={`/jobs/${job.id}`} className="inline-flex">
                    <JobStatusBadge status={job.status} />
                  </Link>
                </TableCell>
                <TableCell>
                  <Link href={`/jobs/${job.id}`} className="hover:underline">
                    {jobSource(job)}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRelativeTime(job.createdAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">{jobDurationCost(job)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
