import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getPlaidClient } from "@/lib/plaid";
import { processWebhook } from "@/lib/engine/webhook";

export const dynamic = "force-dynamic";

/**
 * Plaid webhook receiver. Verifies the signature, dedupes, and drives the
 * payment state machine. Always returns 200 for verified/duplicate deliveries so
 * Plaid does not retry unnecessarily; returns 400 only for unverified payloads.
 */
export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const rawBody = await request.text();
  const plaid = getPlaidClient(env);

  const result = await processWebhook(env.DB, plaid, rawBody, request.headers);

  if (result.status === "unverified") {
    return Response.json({ ok: false, reason: "unverified" }, { status: 400 });
  }
  return Response.json({ ok: true, result });
}
