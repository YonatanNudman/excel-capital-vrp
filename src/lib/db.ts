import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Server-only accessors for the Cloudflare environment and D1 binding.
 * Never import this from client components.
 */
export function getEnv(): CloudflareEnv {
  return getCloudflareContext().env;
}

export function getDb(): D1Database {
  return getCloudflareContext().env.DB;
}

export function nowIso(): string {
  return new Date().toISOString();
}
