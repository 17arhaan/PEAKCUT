import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, users } from "@/lib/db/schema";

export async function getJobsForUser(userId: string) {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.userId, userId))
    .orderBy(desc(jobs.createdAt))
    .limit(50); // ponytail: cap until pagination lands
}

export async function getUserBalance(userId: string): Promise<number> {
  const [row] = await db
    .select({ minutesBalance: users.minutesBalance })
    .from(users)
    .where(eq(users.id, userId));
  return row?.minutesBalance ?? 0;
}
