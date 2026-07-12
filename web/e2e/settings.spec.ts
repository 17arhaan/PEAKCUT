import { test, expect } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email (dev sign-in)").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("settings", () => {
  test("signed-in user sees profile, deletes their account, and a re-sign-in creates a fresh account", async ({
    page,
    request,
  }) => {
    const email = `e2e-settings-${Date.now()}@example.com`;
    await signIn(page, email);

    await page.goto("/settings");
    await expect(page.getByText(email)).toBeVisible();
    // 60-minute signup grant is visible as the balance.
    await expect(page.getByText("60")).toBeVisible();

    const before = await request.get(`/api/test/user?email=${encodeURIComponent(email)}`);
    const beforeBody = await before.json();
    expect(beforeBody.user).not.toBeNull();
    const oldUserId = beforeBody.user.id;

    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel("Type DELETE to confirm account deletion").fill("DELETE");
    await page.getByRole("button", { name: "Permanently delete" }).click();

    // signOut redirects to landing.
    await expect(page).toHaveURL("/");

    // Old account is fully gone.
    const after = await request.get(`/api/test/user?email=${encodeURIComponent(email)}`);
    expect((await after.json()).user).toBeNull();

    // Signing in again with the same email creates a FRESH account (new id,
    // fresh 60-minute grant) -- not a revival of the deleted one.
    await signIn(page, email);
    const fresh = await request.get(`/api/test/user?email=${encodeURIComponent(email)}`);
    const freshBody = await fresh.json();
    expect(freshBody.user).toMatchObject({ email, minutesBalance: 60 });
    expect(freshBody.user.id).not.toBe(oldUserId);
    expect(freshBody.grants).toHaveLength(1);
  });

  test("cancelling the dialog leaves the account untouched", async ({ page }) => {
    const email = `e2e-settings-cancel-${Date.now()}@example.com`;
    await signIn(page, email);
    await page.goto("/settings");

    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Confirm button stays disabled until the exact confirm text is typed.
    await expect(page.getByRole("button", { name: "Permanently delete" })).toBeDisabled();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Still signed in, still on /settings.
    await expect(page.getByText(email)).toBeVisible();
  });
});
