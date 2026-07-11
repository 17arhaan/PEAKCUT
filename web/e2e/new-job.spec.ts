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
    await page.getByRole("button", { name: "Create job" }).click();

    await expect(page).toHaveURL(/\/jobs\/[^/]+$/);

    const jobId = page.url().split("/jobs/")[1];
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job).toBeTruthy();
    expect(job.sourceType).toBe("url");
    expect(job.sourceUrl).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    // STUB_WORKER=1 (see playwright.config.ts) flips status without
    // spawning the real pipeline.
    expect(job.status).toBe("processing");

    await expect(page.getByText(`Job ${jobId}`)).toBeVisible();
  });

  test("rejects a non-URL, non-file submission client-side", async ({ page }) => {
    const email = `e2e-newjob-empty-${Date.now()}@example.com`;
    await signIn(page, email);

    await page.goto("/dashboard/new");
    await page.getByRole("button", { name: "Create job" }).click();

    await expect(page.getByText(/Enter a YouTube URL or choose a file/)).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/new$/);
  });
});
