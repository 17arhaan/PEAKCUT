import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getJobStatusForOwner } from "@/lib/job-status";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  const status = await getJobStatusForOwner(jobId, userId);
  // Not found and not-yours collapse to the same 404 — see
  // getJobStatusForOwner's docstring.
  if (!status) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(status);
}
