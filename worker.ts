/**
 * Custom Worker entrypoint.
 *
 * Wraps the OpenNext-generated handler (which serves the Next.js app) and adds a
 * Cloudflare Cron `scheduled()` handler that runs the daily collection sweep.
 * The generated worker is produced by `opennextjs-cloudflare build` at
 * `.open-next/worker.js`; we import its fetch handler and re-export its cache
 * Durable Objects so wrangler can resolve them.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - .open-next/worker.js is generated at build time (absent in fresh checkouts)
import openNextHandler from "./.open-next/worker.js";
import { runDueCollectionsFromEnv } from "@/lib/engine/cron";

export { BorrowerPaymentCoordinator } from "@/lib/durable/borrower-payment-coordinator";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - generated at build time
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";

export default {
  fetch: openNextHandler.fetch,
  async scheduled(controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    const today = new Date().toISOString().slice(0, 10);
    ctx.waitUntil(runDueCollectionsFromEnv(env, today));
  },
} satisfies ExportedHandler<CloudflareEnv>;
