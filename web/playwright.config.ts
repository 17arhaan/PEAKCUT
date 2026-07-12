import { defineConfig, devices } from "@playwright/test";

// Loads the same DATABASE_URL/AUTH_SECRET/AUTH_DEV that `next dev` picks up
// on its own, so specs can import "@/lib/db" directly to seed rows. Next.js
// loads .env.local for the webServer child process regardless; this just
// gives the Playwright test process (a separate node process) the same env.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local (e.g. CI injects env vars directly) — nothing to load.
}

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // webServer is a single dev-mode (Turbopack, uncompiled routes) Next
  // process shared by every worker — more than ~2-3 concurrent sign-ins
  // starves it and the credentials flow times out. Caps parallelism rather
  // than raising test timeouts to paper over it.
  workers: 2,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Worker seam switch (see lib/worker.ts): a real job spawns
    // `uv run ... shorts run` — minutes of whisper/yt-dlp work, far too
    // heavy for e2e. STUB_WORKER=1 swaps in a no-op worker for this whole
    // dev server process.
    //
    // NEXT_DIST_DIR: a separate build dir from the default `.next` (see
    // next.config.ts) so this :3100 dev server never shares/corrupts build
    // state with a developer's own `npm run dev` already running on :3000.
    env: { ...process.env, STUB_WORKER: "1", NEXT_DIST_DIR: ".next-e2e" },
  },
});
