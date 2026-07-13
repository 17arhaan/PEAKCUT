import { eq } from "drizzle-orm";
import { test, expect } from "@playwright/test";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email (dev sign-in)").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("new job", () => {
  test("signed-in user pastes a URL and is redirected to the job page", async ({ page }) => {
    const email = `e2e-newjob-${Date.now()}@example.com`;
    await signIn(page, email);

    await page.goto("/dashboard/new");
    await page.getByLabel("YouTube URL").fill("https://youtube.com/watch?v=dQw4w9WgXcQ");
    await page.getByRole("button", { name: "Start processing" }).click();

    await expect(page).toHaveURL(/\/jobs\/[^/]+$/);

    const jobId = page.url().split("/jobs/")[1];
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job).toBeTruthy();
    expect(job.sourceType).toBe("url");
    expect(job.sourceUrl).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    // STUB_WORKER=1 flips status asynchronously after createJob returns, so the
    // row read above may still be 'queued' the instant we query -- poll for it.
    await expect
      .poll(async () => {
        const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
        return row.status;
      })
      .toBe("processing");

    // Real job-live page (W8), not the old placeholder -- STUB_WORKER's
    // status flip (processing/ingest/0) is visible via the humanized stage
    // label and the pre-clips empty state.
    await expect(page.getByText("PROCESSING", { exact: true })).toBeVisible();
    await expect(page.getByText("Pulling the source").first()).toBeVisible();
  });

  test("rejects a non-URL, non-file submission client-side", async ({ page }) => {
    const email = `e2e-newjob-empty-${Date.now()}@example.com`;
    await signIn(page, email);

    await page.goto("/dashboard/new");
    await page.getByRole("button", { name: "Start processing" }).click();

    await expect(page.getByText(/Paste a video link or drop a file/)).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/new$/);
  });
});
