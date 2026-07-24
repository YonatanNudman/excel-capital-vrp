import { newId } from "@/lib/ids";

/**
 * Record a webhook event, deduped by the provider event id (primary key).
 * Returns false if this event id was already recorded (duplicate delivery).
 */
export async function recordWebhookEvent(
  db: D1Database,
  data: {
    eventId: string | null;
    type: string | null;
    plaidPaymentId: string | null;
    payload: string;
    signatureVerified: boolean;
  },
): Promise<{ inserted: boolean; processed: boolean; id: string }> {
  const id = data.eventId ?? newId();
  try {
    await db
      .prepare(
        `INSERT INTO webhook_events
          (id, plaid_webhook_type, plaid_payment_id, payload, signature_verified)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, data.type, data.plaidPaymentId, data.payload, data.signatureVerified ? 1 : 0)
      .run();
    return { inserted: true, processed: false, id };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("UNIQUE") || msg.includes("PRIMARY")) {
      const existing = await db
        .prepare("SELECT processed_at FROM webhook_events WHERE id = ?")
        .bind(id)
        .first<{ processed_at: string | null }>();
      return { inserted: false, processed: Boolean(existing?.processed_at), id };
    }
    throw e;
  }
}

export async function markWebhookProcessed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE webhook_events SET processed_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}
