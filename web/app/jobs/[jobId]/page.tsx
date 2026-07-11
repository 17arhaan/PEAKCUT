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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <JobLive jobId={jobId} initialData={initialData} />
    </div>
  );
}
