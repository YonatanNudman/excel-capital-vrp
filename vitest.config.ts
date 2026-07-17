import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Stage 0: pure domain-logic tests (no DB / network) run in the default node env.
// Later stages add a Cloudflare Workers pool project for D1 integration tests.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
