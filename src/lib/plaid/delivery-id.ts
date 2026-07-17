/**
 * Compute a webhook delivery id used for dedupe.
 *
 * Plaid's PAYMENT_STATUS_UPDATE payload has no stable event id, so keying dedupe
 * on payment_id alone would collapse every status transition of a payment into a
 * single "already seen" event. We instead key on (payment_id, status, timestamp)
 * so each distinct transition is processed once, while a true re-delivery of the
 * same transition dedupes. Returns null if there is nothing to key on.
 */
export function webhookDeliveryId(parsed: {
  payment_id?: string;
  new_payment_status?: string;
  event_id?: string;
  timestamp?: string;
}): string | null {
  if (parsed.event_id) return parsed.event_id;
  if (!parsed.payment_id) return null;
  return `${parsed.payment_id}:${parsed.new_payment_status ?? ""}:${parsed.timestamp ?? ""}`;
}
