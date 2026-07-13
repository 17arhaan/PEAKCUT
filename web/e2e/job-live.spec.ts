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

  test("'Why this clip' opens the evidence dialog with score, cited claims, and repair history", async ({ page }) => {
    const email = `e2e-joblive-evidence-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const [job] = await db
      .insert(jobs)
      .values({ userId, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=z", status: "done", stage: "render", progress: 1 })
      .returning();

    // candidate/repairs/qa below are the real values worker recorded for
    // clip index 3 of test/fixtures/run.fixture.json -- a genuine repair
    // (ALIGN fixed by the surgeon route) and a genuine fallback candidate.
    // That recording's score.components evidence arrays are all empty (a
    // silent test video triggers no energy/laughter/rate-surge claims), so
    // one Claim is added per section here to exercise formatClaim's render
    // path end to end.
    await db.insert(clips).values({
      jobId: job.id,
      clipIndex: 3,
      tStart: 38.92,
      tEnd: 57.04,
      score: 71,
      hook: "And even before we had what",
      r2Key: `u/${userId}/${job.id}/clip_3.mp4`,
      thumbKey: `u/${userId}/${job.id}/clip_3_thumb.jpg`,
      status: "ready",
      evidence: {
        score: {
          total: 71,
          verdict: "keep",
          components: {
            hook_strength: { score: 18, evidence: [{ kind: "energy_peak", t: 3.5, value: 2.1 }] },
            payoff: { score: 20, evidence: [] },
            emotion: { score: 15, evidence: [] },
            quotability: { score: 12, evidence: [] },
          },
        },
        candidate: {
          t0: 38.13646662499998,
          t1: 56.88853337499998,
          source: "fallback",
          notes: "",
          evidence: [{ kind: "rate_surge", t: 40, value: 1.6 }],
        },
        repairs: [{ attempt: 1, codes: ["ALIGN"], route: "surgeon", outcome: "fixed" }],
      },
      qa: { passed: true, failures: [] },
    });

    await page.goto(`/jobs/${job.id}`);
    await page.getByRole("button", { name: "Why this clip →" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("71/100")).toBeVisible();
    await expect(dialog.getByText("18/25")).toBeVisible(); // hook_strength component score
    await expect(dialog.getByText("Energy spike +2.1σ at 0:04")).toBeVisible();
    await expect(dialog.getByText("Faster speech at 0:40")).toBeVisible();
    await expect(dialog.getByText("Padding (low-signal content)")).toBeVisible(); // humanized "fallback" source
    await expect(dialog.getByText("Attempt 1: fixed ALIGN via re-cut")).toBeVisible();
    await expect(dialog.getByText("Passed all checks")).toBeVisible();
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

    // Pipeline view renders the current stage + progress from job.stage/progress.
    await expect(page.getByText("PROCESSING", { exact: true })).toBeVisible();
    await expect(page.getByText("Measuring every second").first()).toBeVisible();
    await expect(page.getByText("40% complete")).toBeVisible();

    // Live crew feed shows the humanized event.
    await expect(page.getByText("Scout found 3 moments")).toBeVisible();

    // No clips yet -> no clip videos.
    await expect(page.locator("video")).toHaveCount(0);
  });
});
