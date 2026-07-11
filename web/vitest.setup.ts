// Runs before each test file's imports, so lib/env.ts's module-level
// validation sees these. Points at a separate database on the same
// container (`shorts_factory_test`) — created once via:
//   docker exec web-db-1 psql -U postgres -c "CREATE DATABASE shorts_factory_test"
// and pushed with: DATABASE_URL=...shorts_factory_test npx drizzle-kit push
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/shorts_factory_test";
process.env.AUTH_SECRET ??= "test-secret";
process.env.AUTH_DEV ??= "1";
