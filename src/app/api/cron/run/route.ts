import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runDueCollectionsFromEnv } from "@/lib/engine/cron";

export const dynamic = "force-dynamic";

/**
 * Authenticated internal endpoint to run the daily collection sweep. Guarded by
 * a bearer CRON_SECRET so it can be triggered manually or by an external
 * scheduler. The Cloudflare Cron Trigger runs the same engine via the Worker's
 * scheduled() handler (see worker.ts).
 *
 * PRODUCTION GATE: refuses to run against real Plaid until APP_ENV=production is
 * set intentionally; in every other case it uses the mock client.
 */
export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const auth = request.headers.get("authorization");
  const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
  if (!expected || auth !== expected) {
    return Response.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const summary = await runDueCollectionsFromEnv(env, today);
  return Response.json({ ok: true, summary });
}
