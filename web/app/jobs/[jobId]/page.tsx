import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

// Placeholder — full job detail (stage/progress, clip grid, retry) arrives
// in W8. This just proves createJob's redirect lands on a real,
// ownership-scoped page rather than a 404.
export default async function JobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  const { jobId } = await params;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job || job.userId !== userId) notFound();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 p-6">
      <h1 className="text-lg font-semibold">Job {job.id}</h1>
      <p className="text-sm text-muted-foreground">Status: {job.status}</p>
      {job.stage && <p className="text-sm text-muted-foreground">Stage: {job.stage}</p>}
    </div>
  );
}
