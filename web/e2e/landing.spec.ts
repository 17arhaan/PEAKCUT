import { test, expect } from "@playwright/test";

test("landing page shows pricing and CTA", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start free — 60 minutes" }),
  ).toBeVisible();
});
