import type { PlaidClient } from "@/lib/plaid";
import { recordWebhookEvent, markWebhookProcessed } from "@/lib/repo/webhooks";
import { getPaymentByPlaidId, updatePaymentStatus } from "@/lib/repo/payments";
import { getBorrower } from "@/lib/repo/borrowers";
import { writeAudit } from "@/lib/repo/audit";
import { mapPlaidStatus, canTransition } from "@/lib/payment-state";
import type { Mailer } from "@/lib/mailer";
import { receiptEmail, failureEmail } from "@/lib/mailer/templates";
import type { Payment } from "@/lib/types";

export type WebhookResult =
  | { status: "duplicate" }
  | { status: "unverified" }
  | { status: "ignored"; reason: string }
  | { status: "applied"; paymentId: string; from: string; to: string }
  | { status: "no_change"; paymentId: string; current: string };

/**
 * Process one Plaid webhook delivery. Safe against duplicate deliveries (deduped
 * by event id) and out-of-order deliveries (state machine transition guard).
 */
export async function processWebhook(
  db: D1Database,
  plaid: PlaidClient,
  rawBody: string,
  headers: Headers,
  mailer?: Mailer,
): Promise<WebhookResult> {
  const v = await plaid.verifyWebhook(rawBody, headers);

  // Verify BEFORE recording. Unverified events are stored with a random id (so a
  // forged POST cannot pre-consume a legitimate delivery id and suppress the real
  // webhook), then rejected. Only verified events use the real delivery id for dedupe.
  if (!v.verified) {
    await recordWebhookEvent(db, {
      eventId: null,
      type: v.type,
      plaidPaymentId: v.paymentId,
      payload: rawBody,
      signatureVerified: false,
    });
    return { status: "unverified" };
  }

  const rec = await recordWebhookEvent(db, {
    eventId: v.eventId,
    type: v.type,
    plaidPaymentId: v.paymentId,
    payload: rawBody,
    signatureVerified: true,
  });
  if (!rec.inserted) return { status: "duplicate" };

  if (!v.paymentId || !v.newStatus) {
    await markWebhookProcessed(db, rec.id);
    return { status: "ignored", reason: "no payment status in webhook" };
  }

  const internal = mapPlaidStatus(v.newStatus);
  if (!internal) {
    await markWebhookProcessed(db, rec.id);
    return { status: "ignored", reason: `unmapped status ${v.newStatus}` };
  }

  const payment = await getPaymentByPlaidId(db, v.paymentId);
  if (!payment) {
    await markWebhookProcessed(db, rec.id);
    return { status: "ignored", reason: "unknown payment" };
  }

  if (!canTransition(payment.status, internal)) {
    await markWebhookProcessed(db, rec.id);
    return { status: "no_change", paymentId: payment.id, current: payment.status };
  }

  await updatePaymentStatus(db, payment.id, internal, {
    failureReason: internal === "failed" ? v.newStatus : null,
  });
  await writeAudit(db, {
    actorStaffId: null,
    action: "payment.webhook",
    entityType: "payment",
    entityId: payment.id,
    metadata: { from: payment.status, to: internal, plaidStatus: v.newStatus },
  });

  // Notify the borrower on terminal outcomes. Email is best-effort and must never
  // affect the webhook result: a settled receipt or a failure notice.
  if (mailer) {
    if (internal === "settled") {
      await notifyBorrower(db, mailer, payment, "email.receipt", (borrowerName) =>
        receiptEmail({
          borrowerName,
          amountMinor: payment.amount_minor,
          currency: payment.currency,
          reference: payment.reference ?? "",
          date: new Date().toISOString().slice(0, 10),
        }),
      );
    } else if (internal === "failed" || internal === "rejected") {
      await notifyBorrower(db, mailer, payment, "email.failure", (borrowerName) =>
        failureEmail({
          borrowerName,
          amountMinor: payment.amount_minor,
          currency: payment.currency,
          reference: payment.reference ?? "",
        }),
      );
    }
  }

  await markWebhookProcessed(db, rec.id);
  return { status: "applied", paymentId: payment.id, from: payment.status, to: internal };
}

/**
 * Send one borrower email for a payment and audit the attempt. Skips silently
 * when the borrower has no contact_email. Never throws.
 */
async function notifyBorrower(
  db: D1Database,
  mailer: Mailer,
  payment: Payment,
  action: "email.receipt" | "email.failure",
  build: (borrowerName: string) => { subject: string; text: string },
): Promise<void> {
  const borrower = await getBorrower(db, payment.borrower_id);
  if (!borrower?.contact_email) return;

  const { subject, text } = build(borrower.legal_name);
  const result = await mailer.send({ to: borrower.contact_email, subject, text });
  await writeAudit(db, {
    actorStaffId: null,
    action,
    entityType: "payment",
    entityId: payment.id,
    metadata: { mode: mailer.mode, ok: result.ok, to: borrower.contact_email },
  });
}
