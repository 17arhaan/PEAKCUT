import { test, expect } from "@playwright/test";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email (dev sign-in)").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("dashboard", () => {
  test("signed-in user with no jobs sees the empty state", async ({ page }) => {
    const email = `e2e-dash-empty-${Date.now()}@example.com`;
    await signIn(page, email);

    await expect(page.getByText("No jobs yet")).toBeVisible();
    await expect(page.getByText("Paste a YouTube link to get your first clips.")).toBeVisible();
  });

  test("a seeded job appears in the list with its status badge", async ({ page, request }) => {
    const email = `e2e-dash-job-${Date.now()}@example.com`;
    await signIn(page, email);

    const res = await request.get(`/api/test/user?email=${encodeURIComponent(email)}`);
    const { user } = await res.json();

    await db.insert(jobs).values({
      userId: user.id,
      sourceType: "url",
      sourceUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      status: "queued",
    });

    await page.reload();

    await expect(page.getByText("Queued")).toBeVisible();
    await expect(page.getByText("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBeVisible();
  });
});
