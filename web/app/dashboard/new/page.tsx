import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { NewJobForm } from "./new-job-form";

export default async function NewJobPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold">New job</h1>
      <NewJobForm userId={userId} />
    </div>
  );
}
