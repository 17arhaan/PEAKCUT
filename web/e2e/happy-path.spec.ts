import { test, expect } from "@playwright/test";

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

// The full spec §8 exit-criterion journey: signup -> new job via URL ->
// live progress -> real clips (scores + hooks) -> evidence panel ->
// download link resolves -> restyle. STUB_WORKER=1 (playwright.config.ts)
// swaps in StubWorker, which -- after a short fixed delay (see
// lib/worker.ts's STUB_IMPORT_DELAY_MS) -- copies the committed
// test/fixtures/run.fixture.json into the job's outDir and runs it through
// the REAL importRun, so everything below this point (clips, scores, hooks,
// evidence, media URLs) is the real import path exercising real fixture
// data, not hand-seeded rows.
test.describe("happy path", () => {
  test("signup -> URL job -> live progress -> clips with scores/hooks -> evidence -> download link -> restyle", async ({
    page,
  }) => {
    const email = `e2e-happypath-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    // New job via URL.
    await page.goto("/dashboard/new");
    await page.getByLabel("YouTube URL").fill("https://youtube.com/watch?v=dQw4w9WgXcQ");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(page).toHaveURL(/\/jobs\/[^/]+$/);
    const jobId = page.url().split("/jobs/")[1];

    // Live view shows progress before the stub fixture import lands (see
    // STUB_IMPORT_DELAY_MS) -- same immediate state new-job.spec.ts checks.
    await expect(page.getByText("Downloading")).toBeVisible();
    await expect(page.getByText("Working on your clips…")).toBeVisible();

    // Wait out the stub's fixture import (real importRun run against
    // test/fixtures/run.fixture.json -- 4 clips, one dropped as BLACK).
    // Generous timeout: STUB_IMPORT_DELAY_MS + import work + a client poll
    // tick (JobLive.tsx polls every 2s), comfortable on a slow CI runner.
    const clip1Hook = page.getByText("Novelist, Essayist And Philosopher, Rona");
    await expect(clip1Hook).toBeVisible({ timeout: 20_000 });

    // Clips appear with scores + hooks. Fixture's clip 1 is ready with a
    // real (if zero -- a silent test video) score; clip 2 is dropped (BLACK).
    await expect(page.getByText("0/100").first()).toBeVisible();
    await expect(page.getByText(/Dropped: BLACK/)).toBeVisible();
    const video = page.locator("video");
    await expect(video.first()).toHaveAttribute("src", `/api/media/u/${userId}/${jobId}/clip_1.mp4`);

    // Evidence panel: open "Why this clip" on clip 1's card. Clips render
    // in clipIndex order and only ready clips get this button -- clip 1 is
    // the first ready clip (clip 2 is the dropped BLACK one, no button) --
    // so the first button on the page is unambiguously clip 1's.
    await page.getByRole("button", { name: "Why this clip →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("0/100")).toBeVisible();
    await expect(dialog.getByText("borderline")).toBeVisible();
    await expect(dialog.getByText("Padding (low-signal content)")).toBeVisible(); // humanized candidate.source "fallback"
    await expect(dialog.getByText("Passed all checks")).toBeVisible();
    await page.keyboard.press("Escape");

    // Download link resolves to a real /api/media/... URL, and the route
    // actually serves the stub-written bytes (not asserting a browser
    // "download" happens, per the brief -- just that the href is correct
    // and the server responds 200 for it).
    const downloadLink = page.locator(`a[href="/api/media/u/${userId}/${jobId}/clip_1.mp4"][download]`);
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    const mediaRes = await page.request.get(href!);
    expect(mediaRes.status()).toBe(200);
    expect(await mediaRes.text()).toBe("stub-mp4-1");

    // Optional: restyle to s2. StubWorker.renderStyle is a no-op (same as
    // e2e/caption-style.spec.ts), so this only exercises the optimistic
    // in-flight state, not a completed restyle.
    const style2 = page.getByRole("button", { name: "Style 2" });
    await expect(style2).toBeEnabled();
    await style2.click();
    await expect(page.getByText("Applying Style 2…")).toBeVisible();
    await expect(page.getByText("Applying new caption style")).toBeVisible();
  });
});
