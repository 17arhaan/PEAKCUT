import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets playwright.config.ts point its own `next dev` at a separate build
  // dir (see there) so it doesn't collide with a `.next` a developer's own
  // `npm run dev` on :3000 is concurrently writing to.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
