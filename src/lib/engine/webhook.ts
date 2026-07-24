import { decryptString, sha256Hex } from "@/lib/crypto";
import type { Mailer } from "@/lib/mailer";
import { failureEmail, receiptEmail } from "@/lib/mailer/templates";
import { mapPlaidStatus } from "@/lib/payment-state";
import type { PlaidClient } from "@/lib/plaid";
import { writeAudit } from "@/lib/repo/audit";
import { getBorrower } from "@/lib/repo/borrowers";
import {
  getConsentByPlaidHash,
  listConsentsMissingPlaidHash,
  setConsentPlaidHash,
} from "@/lib/repo/consents";
import { applyPaymentTransition, getPaymentByPlaidId } from "@/lib/repo/payments";
import { markWebhookProcessed, recordWebhookEvent } from "@/lib/repo/webhooks";
import type { ConsentStatus, Payment } from "@/lib/types";

export type WebhookResult =
  | { status: "duplicate" }
  | { status: "retry"; reason: string }
  | { status: "unverified" }
  | { status: "ignored"; reason: string }
  | { status: "applied"; paymentId: string; from: string; to: string }
  | { status: "consent_applied"; consentId: string; to: string }
  | { status: "no_change"; paymentId: string; current: string };

/** Verify, dedupe and atomically apply a Plaid webhook delivery. */
export async function processWebhook(
  db: D1Database,
  plaid: PlaidClient,
  rawBody: string,
  headers: Headers,
  mailer?: Mailer,
  encryptionKey?: string,
): Promise<WebhookResult> {
  const verification = await plaid.verifyWebhook(rawBody, headers);
  if (!verification.verified) return { status: "unverified" };

  const record = await recordWebhookEvent(db, {
    eventId: verification.eventId,
    type: verification.type,
    plaidPaymentId: verification.paymentId,
    payload: rawBody,
    signatureVerified: true,
  });
  if (!record.inserted && record.processed) return { status: "duplicate" };

  if (verification.consentId && verification.newConsentStatus) {
    const result = await applyConsentWebhook(
      db,
      verification.consentId,
      verification.newConsentStatus,
      encryptionKey,
    );
    if (result.status !== "retry") await markWebhookProcessed(db, record.id);
    return result;
  }

  if (!verification.paymentId || !verification.newStatus) {
    await markWebhookProcessed(db, record.id);
    return { status: "ignored", reason: "no payment or consent status in webhook" };
  }

  const internal = mapPlaidStatus(verification.newStatus);
  if (!internal) {
    // Preserve the event for investigation but acknowledge it; reconciliation
    // remains authoritative for statuses introduced by Plaid in the future.
    await markWebhookProcessed(db, record.id);
    return { status: "ignored", reason: `unmapped status ${verification.newStatus}` };
  }

  const payment = await getPaymentByPlaidId(db, verification.paymentId);
  if (!payment) {
    // The execute response may not yet have reached D1. Leave this event
    // unprocessed and ask Plaid to redeliver rather than losing the transition.
    return { status: "retry", reason: "payment not persisted yet" };
  }

  const transition = await applyPaymentTransition(db, payment.id, internal, {
    failureReason: internal === "failed" || internal === "rejected" ? verification.newStatus : null,
  });
  if (!transition?.applied) {
    await markWebhookProcessed(db, record.id);
    return { status: "no_change", paymentId: payment.id, current: transition?.current ?? payment.status };
  }

  await writeAudit(db, {
    actorStaffId: null,
    action: "payment.webhook",
    entityType: "payment",
    entityId: payment.id,
    metadata: { from: transition.from, to: internal, plaidStatus: verification.newStatus },
  });
  await markWebhookProcessed(db, record.id);

  if (mailer) {
    try {
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
    } catch (error) {
      console.error(`webhook notification failed for payment ${payment.id}`, error);
    }
  }

  return { status: "applied", paymentId: payment.id, from: transition.from, to: internal };
}

async function applyConsentWebhook(
  db: D1Database,
  plaidConsentId: string,
  providerStatus: string,
  encryptionKey?: string,
): Promise<WebhookResult> {
  const hash = await sha256Hex(plaidConsentId);
  let consent = await getConsentByPlaidHash(db, hash);
  if (!consent && encryptionKey) {
    for (const candidate of await listConsentsMissingPlaidHash(db)) {
      try {
        if (
          candidate.plaid_consent_id &&
          await decryptString(candidate.plaid_consent_id, encryptionKey) === plaidConsentId
        ) {
          consent = candidate;
          await setConsentPlaidHash(db, candidate.id, hash);
          break;
        }
      } catch {
        // A malformed legacy row must not block processing other candidates.
      }
    }
  }
  if (!consent) return { status: "retry", reason: "consent not persisted yet" };
  const status = mapConsentStatus(providerStatus);
  if (!status) return { status: "ignored", reason: `unmapped consent status ${providerStatus}` };

  const now = new Date().toISOString();
  const statements = [
    db.prepare(
      `UPDATE consents SET status = ?,
       authorized_at = CASE WHEN ? = 'authorized' THEN ? ELSE authorized_at END
       WHERE id = ?`,
    ).bind(status, status, now, consent.id),
  ];
  if (status === "authorized") {
    statements.push(db.prepare("UPDATE borrowers SET status = 'active' WHERE id = ?")
      .bind(consent.borrower_id));
  } else if (status === "revoked" || status === "expired") {
    statements.push(db.prepare("UPDATE borrowers SET status = ? WHERE id = ?")
      .bind(status, consent.borrower_id));
  }
  await db.batch(statements);
  await writeAudit(db, {
    actorStaffId: null,
    action: "consent.webhook",
    entityType: "consent",
    entityId: consent.id,
    metadata: { providerStatus, status },
  });
  return { status: "consent_applied", consentId: consent.id, to: status };
}

function mapConsentStatus(status: string): ConsentStatus | null {
  switch (status.toUpperCase()) {
    case "AUTHORISED":
    case "AUTHORIZED":
      return "authorized";
    case "REVOKED":
      return "revoked";
    case "EXPIRED":
      return "expired";
    case "REJECTED":
      return "rejected";
    case "PENDING":
      return "pending";
    default:
      return null;
  }
}

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
