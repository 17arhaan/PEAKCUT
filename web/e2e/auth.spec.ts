import { test, expect } from "@playwright/test";

test.describe("auth", () => {
  test("unauthenticated /dashboard redirects to /signin", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/signin/);
  });

  test("dev sign-in lands on /dashboard and shows email in header", async ({ page }) => {
    const email = `e2e-${Date.now()}@example.com`;

    await page.goto("/signin");
    await page.getByLabel("Email (dev sign-in)").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(email)).toBeVisible();
  });

  test("dev sign-in creates a user row with a one-time 60-minute signup grant", async ({
    page,
    request,
  }) => {
    const email = `e2e-grant-${Date.now()}@example.com`;

    await page.goto("/signin");
    await page.getByLabel("Email (dev sign-in)").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    const res = await request.get(`/api/test/user?email=${encodeURIComponent(email)}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();

    expect(body.user).toMatchObject({ email, minutesBalance: 60 });
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({
      reason: "signup_grant",
      ref: body.user.id,
      deltaMinutes: 60,
    });
  });
});
