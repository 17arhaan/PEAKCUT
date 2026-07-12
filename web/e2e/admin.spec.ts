import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "17arhaan@gmail.com"; // default ADMIN_EMAILS (lib/admin.ts)

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email (dev sign-in)").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("admin access gate (security core)", () => {
  test("unauthenticated GET /admin is a 404, never a redirect", async ({ page }) => {
    const response = await page.goto("/admin");
    expect(response?.status()).toBe(404);
    // proves it's a 404, not a redirect to /signin revealing the route exists
    await expect(page).toHaveURL(/\/admin/);
  });

  test("non-admin signed-in GET /admin is a 404 with zero cross-user data in the response", async ({ page }) => {
    const email = `e2e-admin-nonadmin-${Date.now()}@example.com`;
    await signIn(page, email);

    const response = await page.goto("/admin");
    expect(response?.status()).toBe(404);

    const body = await page.content();
    expect(body).not.toContain("Total users");
    expect(body).not.toContain("Recent jobs");
    expect(body).not.toContain("Recent signups");
    expect(body).not.toContain("Recent failures");
  });

  test("admin sees the page with stats and cross-user sections", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);

    const response = await page.goto("/admin");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    await expect(page.getByText("Total users")).toBeVisible();
    await expect(page.getByText("Recent jobs")).toBeVisible();
    await expect(page.getByText("Recent signups")).toBeVisible();
    await expect(page.getByText("Recent failures")).toBeVisible();
  });
});

test.describe("admin nav link", () => {
  // The header's "Admin" nav link is a shadcn Button rendered as an <a> via
  // render={<Link/>} -- Base UI keeps role="button" for these (same as the
  // existing "Settings" nav item), so it's queried by button role, not link.
  test("absent for a non-admin", async ({ page }) => {
    const email = `e2e-admin-navlink-non-${Date.now()}@example.com`;
    await signIn(page, email);
    await expect(page.getByRole("button", { name: "Admin" })).toHaveCount(0);
  });

  test("visible for the admin", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await expect(page.getByRole("button", { name: "Admin" })).toBeVisible();
  });
});
