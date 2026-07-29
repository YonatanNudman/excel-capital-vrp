import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Stage 0: pure domain-logic tests (no DB / network) run in the default node env.
// Later stages add a Cloudflare Workers pool project for D1 integration tests.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` is a Next.js build-time guard with no runtime module.
      // Stub it so server modules can be imported by node-pool tests.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    // Pure domain-logic tests only (top-level). D1 integration tests live in
    // tests/integration and run under the Workers pool (vitest.workers.config.ts).
    include: ["tests/*.test.ts"],
    environment: "node",
  },
});
