import { eq } from "drizzle-orm";
import { test, expect } from "@playwright/test";
import { db } from "@/lib/db";
import { clips, jobs } from "@/lib/db/schema";

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

// W11: STUB_WORKER=1 (see playwright.config.ts) swaps in the no-op
// StubWorker.renderStyle -- a real re-render subprocess is far too heavy
// for e2e, so this only exercises reRenderStyle's synchronous part (the
// status flip to 'processing' + the optimistic UI indicator), not an actual
// completed restyle. See lib/worker.ts's StubWorker doc comment.
test.describe("caption style switcher", () => {
  test("clicking a style on a done job flips it to processing and shows the applying indicator", async ({
    page,
  }) => {
    const email = `e2e-restyle-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const [job] = await db
      .insert(jobs)
      .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=x", status: "done", stage: "render", progress: 1 })
      .returning();

    await db.insert(clips).values({
      jobId: job.id,
      clipIndex: 1,
      tStart: 0,
      tEnd: 10,
      score: 87,
      hook: "You won't believe this",
      r2Key: `u/${userId}/${job.id}/clip_1.mp4`,
      thumbKey: `u/${userId}/${job.id}/clip_1_thumb.jpg`,
      status: "ready",
    });

    await page.goto(`/jobs/${job.id}`);

    // Style selector visible, no style active yet (original render, not one
    // of s1/s2/s3 -- see lib/db/schema.ts's activeStyle doc comment).
    await expect(page.getByText("Caption style:")).toBeVisible();
    const style2 = page.getByRole("button", { name: "Style 2" });
    await expect(style2).toBeVisible();
    await expect(style2).toBeEnabled();

    await style2.click();

    // Optimistic "applying" indicator for the clicked style.
    await expect(page.getByText("Applying Style 2…")).toBeVisible();

    // Job flips to processing -- both the status badge and the DB row.
    await expect(page.getByText("Applying new caption style")).toBeVisible();
    await expect
      .poll(async () => {
        const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
        return row.status;
      })
      .toBe("processing");

    // Buttons disabled while restyling -- only 'done' jobs are restyleable.
    await expect(page.getByRole("button", { name: "Style 1" })).toBeDisabled();
  });

  test("the style selector is not offered while a job is still processing", async ({ page }) => {
    const email = `e2e-restyle-processing-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const [job] = await db
      .insert(jobs)
      .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=y", status: "processing", stage: "render", progress: 0.9 })
      .returning();

    await db.insert(clips).values({
      jobId: job.id,
      clipIndex: 1,
      tStart: 0,
      tEnd: 10,
      score: 60,
      hook: "hook",
      r2Key: `u/${userId}/${job.id}/clip_1.mp4`,
      thumbKey: `u/${userId}/${job.id}/clip_1_thumb.jpg`,
      status: "ready",
    });

    await page.goto(`/jobs/${job.id}`);

    await expect(page.getByRole("button", { name: "Style 1" })).toBeDisabled();
  });
});
