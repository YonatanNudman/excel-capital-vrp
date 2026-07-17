import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1 integration tests for the money engines, run inside workerd (real D1) with
// the mock Plaid client. Tests import the engines directly, so no Worker `main`
// is needed — bindings come from miniflare below. Migrations are applied in the
// setup file from the TEST_MIGRATIONS binding.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        miniflare: {
          compatibilityDate: "2026-07-17",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENCRYPTION_KEY: "test-encryption-key",
            APP_ENV: "development",
            PLAID_ENV: "sandbox",
            CRON_SECRET: "test-cron-secret",
          },
        },
      };
    }),
  ],
  resolve: {
    alias: { "@": path.join(__dirname, "src") },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/apply-migrations.ts"],
  },
});
