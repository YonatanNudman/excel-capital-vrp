import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    APP_ENCRYPTION_KEY: string;
    APP_ENV: string;
    PLAID_ENV: string;
    CRON_SECRET: string;
  }
}
