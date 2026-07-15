import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { clips, creditLedger, jobs, users } from "@/lib/db/schema";
import { balance, debit } from "@/lib/credits";
import { POST } from "./route";

const SECRET = process.env.WORKER_SHARED_SECRET!;
const ESTIMATE_MINUTES = 30;
const FIXTURE_RUN_PATH = path.join(process.cwd(), "test/fixtures/run.fixture.json");

function callbackRequest(payload: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["authorization"] = `Bearer ${secret}`;
  return new Request("http://localhost/api/worker/callback", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

const createdUserIds: string[] = [];

async function makeJobWithDebit(): Promise<{ userId: string; jobId: string }> {
  const userId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `cb-test-${userId}@example.com`, minutesBalance: 100 });
  createdUserIds.push(userId);
  await db.insert(jobs).values({
    id: jobId,
    userId,
    sourceType: "url",
    sourceUrl: "https://youtube.com/watch?v=x",
    status: "processing",
  });
  await debit(userId, ESTIMATE_MINUTES, jobId);
  return { userId, jobId };
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    const userJobs = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId));
    for (const j of userJobs) {
      await db.delete(clips).where(eq(clips.jobId, j.id));
    }
    await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
    await db.delete(jobs).where(eq(jobs.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("POST /api/worker/callback auth", () => {
  it("401s without a bearer token", async () => {
    const res = await POST(callbackRequest({ type: "progress", job_id: "x", agent: "scout" }, null));
    expect(res.status).toBe(401);
  });

  it("401s with the wrong secret", async () => {
    const res = await POST(callbackRequest({ type: "progress", job_id: "x", agent: "scout" }, "nope"));
    expect(res.status).toBe(401);
  });

  it("400s on a payload that matches no shape", async () => {
    const res = await POST(callbackRequest({ type: "??", job_id: "x" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/worker/callback payloads", () => {
  it("progress advances the job's stage", async () => {
    const { jobId } = await makeJobWithDebit();

    const res = await POST(callbackRequest({ type: "progress", job_id: jobId, agent: "critic" }));

    expect(res.status).toBe(200);
    const [row] = await db.select({ stage: jobs.stage }).from(jobs).where(eq(jobs.id, jobId));
    expect(row.stage).toBe("crew");
  });

  it("error marks the job failed and refunds the estimate", async () => {
    const { userId, jobId } = await makeJobWithDebit();
    const before = await balance(userId);

    const res = await POST(callbackRequest({ type: "error", job_id: jobId, error: "gpu exploded" }));

    expect(res.status).toBe(200);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("gpu exploded");
    expect(await balance(userId)).toBe(before + ESTIMATE_MINUTES);
  });

  it("done imports the run body with preuploaded conventional keys", async () => {
    const { userId, jobId } = await makeJobWithDebit();
    const runJson = await readFile(FIXTURE_RUN_PATH, "utf8");

    const res = await POST(callbackRequest({ type: "done", job_id: jobId, run_json: runJson }));

    expect(res.status).toBe(200);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row.status).toBe("done");
    const clipRows = await db.select().from(clips).where(eq(clips.jobId, jobId));
    expect(clipRows.length).toBeGreaterThan(0);
    const ready = clipRows.find((c) => c.status === "ready");
    expect(ready?.r2Key).toBe(`u/${userId}/${jobId}/clip_${ready?.clipIndex}.mp4`);
  });
});
