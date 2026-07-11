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

test.describe("upload + media serving", () => {
  test("signed-in user uploads a file via the route and reads it back", async ({ page }) => {
    const email = `e2e-upload-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const key = `u/${userId}/job1/hello.txt`;
    const body = "hello from playwright";

    const uploadRes = await page.request.post(`/api/upload?key=${encodeURIComponent(key)}`, {
      data: body,
      headers: { "content-type": "text/plain" },
    });
    expect(uploadRes.status()).toBe(200);
    expect(await uploadRes.json()).toEqual({ key });

    const getRes = await page.request.get(`/api/media/${key}`);
    expect(getRes.status()).toBe(200);
    expect(await getRes.text()).toBe(body);
    expect(getRes.headers()["accept-ranges"]).toBe("bytes");
  });

  test("Range requests return 206 with the requested byte slice", async ({ page }) => {
    const email = `e2e-upload-range-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const key = `u/${userId}/job1/clip.mp4`;
    const body = "0123456789";

    await page.request.post(`/api/upload?key=${encodeURIComponent(key)}`, { data: body });

    const rangeRes = await page.request.get(`/api/media/${key}`, {
      headers: { range: "bytes=2-5" },
    });
    expect(rangeRes.status()).toBe(206);
    expect(rangeRes.headers()["content-range"]).toBe("bytes 2-5/10");
    expect(await rangeRes.text()).toBe("2345");
  });

  test("cross-user GET is rejected", async ({ page, browser }) => {
    const emailA = `e2e-upload-a-${Date.now()}@example.com`;
    await signIn(page, emailA);
    const userIdA = await testUserId(page, emailA);

    const key = `u/${userIdA}/job1/secret.txt`;
    const uploadRes = await page.request.post(`/api/upload?key=${encodeURIComponent(key)}`, {
      data: "top secret",
    });
    expect(uploadRes.status()).toBe(200);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const emailB = `e2e-upload-b-${Date.now()}@example.com`;
    await signIn(pageB, emailB);

    const crossGetRes = await pageB.request.get(`/api/media/${key}`);
    expect([403, 404]).toContain(crossGetRes.status());

    const crossPutRes = await pageB.request.post(
      `/api/upload?key=${encodeURIComponent(key)}`,
      { data: "overwritten" },
    );
    expect([403, 404]).toContain(crossPutRes.status());

    await contextB.close();
  });

  test("rejects path-traversal and absolute-path keys on both routes", async ({ page }) => {
    const email = `e2e-upload-trav-${Date.now()}@example.com`;
    await signIn(page, email);
    const userId = await testUserId(page, email);

    const badKeys = [
      `u/${userId}/../../../../etc/passwd`,
      "/etc/passwd",
      "../../etc/passwd",
    ];

    for (const key of badKeys) {
      const uploadRes = await page.request.post(`/api/upload?key=${encodeURIComponent(key)}`, {
        data: "x",
      });
      expect(uploadRes.status(), `upload should reject key ${key}`).toBeGreaterThanOrEqual(400);
      expect(uploadRes.status(), `upload should reject key ${key}`).toBeLessThan(500);
    }

    // Encoded traversal via the catch-all media route: each %2e%2e segment
    // decodes to a literal ".." before sanitizeKey ever sees it.
    const mediaRes = await page.request.get("/api/media/%2e%2e/%2e%2e/etc/passwd");
    expect(mediaRes.status()).toBeGreaterThanOrEqual(400);
    expect(mediaRes.status()).toBeLessThan(500);
  });
});
