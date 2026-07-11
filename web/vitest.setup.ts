import { execSync } from "node:child_process";

// Runs before each test file's imports, so lib/env.ts's module-level
// validation sees these. Points at a separate database on the same
// container (`shorts_factory_test`) — created via docker init scripts or
// this fallback guard.
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/shorts_factory_test";
process.env.AUTH_SECRET ??= "test-secret";
process.env.AUTH_DEV ??= "1";

// Ensure test DB exists and schema is deployed (fallback for existing containers).
// ponytail: one-shot create-and-push; idempotent so safe to run per test suite
try {
  execSync(
    `docker exec web-db-1 psql -U postgres -c "CREATE DATABASE shorts_factory_test" 2>&1 || true`,
    { stdio: "ignore" }
  );
  // Push schema to test DB (idempotent operation)
  execSync(`DATABASE_URL="${process.env.DATABASE_URL}" npx drizzle-kit push`, {
    stdio: "ignore",
  });
} catch {
  // Silently fail if docker/psql unavailable (tests will fail more clearly if DB is truly unavailable)
}
