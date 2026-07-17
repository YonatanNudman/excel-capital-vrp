import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getPlaidClient, isPlaidConfigured } from "@/lib/plaid";
import { processWebhook } from "@/lib/engine/webhook";
import { getMailer, type MailerEnv } from "@/lib/mailer";

export const dynamic = "force-dynamic";

/**
 * Plaid webhook receiver. Verifies the signature, dedupes, and drives the
 * payment state machine. Always returns 200 for verified/duplicate deliveries so
 * Plaid does not retry unnecessarily; returns 400 only for unverified payloads.
 *
 * The mock client trusts any payload, so this endpoint is only accepted in local
 * development when Plaid is not configured; deployed environments require real
 * Plaid credentials (real signature verification).
 */
export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  if (!isPlaidConfigured(env) && env.APP_ENV !== "development") {
    return Response.json({ ok: false, error: "webhooks disabled (Plaid not configured)" }, { status: 503 });
  }
  const rawBody = await request.text();
  const plaid = getPlaidClient(env);
  const mailer = getMailer(env as MailerEnv);

  const result = await processWebhook(env.DB, plaid, rawBody, request.headers, mailer);

  if (result.status === "unverified") {
    return Response.json({ ok: false, reason: "unverified" }, { status: 400 });
  }
  return Response.json({ ok: true, result });
}
