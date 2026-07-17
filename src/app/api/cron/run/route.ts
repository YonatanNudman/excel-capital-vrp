import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runDueCollectionsFromEnv } from "@/lib/engine/cron";

export const dynamic = "force-dynamic";

/**
 * Authenticated internal endpoint to run the daily collection sweep. Guarded by
 * a bearer CRON_SECRET so it can be triggered manually or by an external
 * scheduler. The Cloudflare Cron Trigger runs the same engine via the Worker's
 * scheduled() handler (see worker.ts).
 *
 * Real vs mock Plaid is decided by getPlaidClient(): the real client is used
 * only when PLAID_CLIENT_ID/PLAID_SECRET are present. Real payments therefore
 * move only once real credentials (with PLAID_ENV=production) are configured,
 * which is the owner's explicit production go-live step. In production the mock
 * client is refused outright (getPlaidClient throws).
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
