import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Apply the real migrations to each isolated test D1 before tests run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
