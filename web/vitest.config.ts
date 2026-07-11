import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    // mirrors tsconfig.json's "@/*" -> "./*" path alias
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
