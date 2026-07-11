import { test, expect } from "@playwright/test";
import { db } from "@/lib/db";
import { agentEvents, clips, jobs } from "@/lib/db/schema";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email (dev sign-in)").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function testUserId(page: import("@playwright/test").Page, email: string): Promise<string> {
  const res = await page.request.get(`/api/test/user?email=${encodeURIComponent(email)}`);
  const { user } = await res.json();
  return user.id as string;
}

test.describe("job live view", () => {
  test("a done job renders the clip grid: ready clip with video/score/hook/download, dropped clip greyed", async ({
    page,
  }) => {
    const email = `e2e-joblive-done-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const [job] = await db
      .insert(jobs)
      .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=x", status: "done", stage: "render", progress: 1 })
      .returning();

    // r2Key/thumbKey point at storage keys that don't need to exist on disk
    // for this test -- the grid only needs the <video> element's src
    // attribute to be a getUrl()-shaped /api/media/ path, not a byte that's
    // actually fetched/played by the test.
    await db.insert(clips).values([
      {
        jobId: job.id,
        clipIndex: 1,
        tStart: 0,
        tEnd: 10,
        score: 87,
        hook: "You won't believe this",
        r2Key: `u/${userId}/${job.id}/clip_1.mp4`,
        thumbKey: `u/${userId}/${job.id}/clip_1_thumb.jpg`,
        status: "ready",
      },
      {
        jobId: job.id,
        clipIndex: 2,
        tStart: 11,
        tEnd: 20,
        status: "dropped",
        droppedReason: "BLACK",
      },
    ]);

    await page.goto(`/jobs/${job.id}`);

    // Ready clip: hook, score badge, video element with a real src, download link.
    await expect(page.getByText("You won't believe this")).toBeVisible();
    await expect(page.getByText("87/100")).toBeVisible();
    const video = page.locator("video");
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("src", `/api/media/u/${userId}/${job.id}/clip_1.mp4`);
    const downloadLink = page.locator(`a[href="/api/media/u/${userId}/${job.id}/clip_1.mp4"][download]`);
    await expect(downloadLink).toBeVisible();

    // Dropped clip: greyed card with reason, no video/download for it.
    await expect(page.getByText("Dropped: BLACK")).toBeVisible();
  });

  test("a processing job shows the progress bar, stage label, and activity feed", async ({ page }) => {
    const email = `e2e-joblive-processing-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const [job] = await db
      .insert(jobs)
      .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=y", status: "processing", stage: "signals", progress: 0.4 })
      .returning();

    await db.insert(agentEvents).values({ jobId: job.id, agent: "scout", action: "found", payload: { count: 3 } });

    await page.goto(`/jobs/${job.id}`);

    // Stage label humanized from job.stage.
    await expect(page.getByText("Analyzing audio & video")).toBeVisible();

    // Progress bar reflects job.progress (0..1 -> 0..100).
    const progressbar = page.getByRole("progressbar");
    await expect(progressbar).toBeVisible();
    await expect(progressbar).toHaveAttribute("aria-valuenow", "40");

    // Activity feed shows the humanized event.
    await expect(page.getByText("Scout found 3 moments")).toBeVisible();

    // No clips yet -> the early/empty state, not the clip grid.
    await expect(page.getByText("Working on your clips…")).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
  });
});
