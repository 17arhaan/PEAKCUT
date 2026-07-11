import { defineConfig } from "drizzle-kit";

// drizzle-kit is a CLI, not app runtime code, so it doesn't go through
// lib/env.ts. drizzle-kit doesn't auto-load .env files — Node 20.6+ does
// (process.loadEnvFile), so pull in .env.local directly.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local (e.g. CI with DATABASE_URL already in the environment)
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/shorts_factory",
  },
});
