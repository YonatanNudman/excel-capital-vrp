import type { PlaidClient } from "@/lib/plaid";
import { PlaidApiError } from "@/lib/plaid";
import { getBorrower } from "@/lib/repo/borrowers";
import { getActiveConsent } from "@/lib/repo/consents";
import {
  DuplicatePaymentError,
  getPayment,
  insertPayment,
  setPaymentPlaidId,
  updatePaymentStatus,
} from "@/lib/repo/payments";
import { writeAudit } from "@/lib/repo/audit";
import { decryptString } from "@/lib/crypto";
import { mapPlaidStatus } from "@/lib/payment-state";
import type { Payment } from "@/lib/types";
import type { Mailer } from "@/lib/mailer";
import { failureEmail } from "@/lib/mailer/templates";

export type CollectOutcome =
  | { kind: "duplicate"; idempotencyKey: string }
  | { kind: "skipped"; reason: string }
  | { kind: "collected"; payment: Payment; plaidStatus: string }
  | { kind: "failed"; payment: Payment; reason: string };

export interface CollectInput {
  borrowerId: string;
  amountMinor: number;
  currency?: string;
  reference: string;
  idempotencyKey: string;
  scheduledFor?: string | null;
  retryOf?: string | null;
  actorStaffId: string | null;
}

/**
 * Execute a single collection for a borrower. This is the ONLY path that moves
 * money, and it enforces every safety rule:
 *  - borrower must be collectable (active / onboarding, not paused/revoked/expired)
 *  - an authorised consent must exist
 *  - the payment row is inserted BEFORE calling Plaid, keyed by idempotency_key,
 *    so a duplicate attempt is rejected by the DB (no double-collection)
 *  - the Plaid status is mapped to an internal status; INITIATED is treated as
 *    successfully submitted
 *  - Plaid/network errors mark the payment failed (retry-eligible), never silent
 */
export async function collectPayment(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  input: CollectInput,
  mailer?: Mailer,
): Promise<CollectOutcome> {
  const borrower = await getBorrower(db, input.borrowerId);
  if (!borrower) return { kind: "skipped", reason: "borrower not found" };
  if (borrower.status === "paused") return { kind: "skipped", reason: "collections paused" };
  if (borrower.status === "revoked" || borrower.status === "expired") {
    return { kind: "skipped", reason: `consent ${borrower.status}` };
  }

  const consent = await getActiveConsent(db, input.borrowerId);
  if (!consent || consent.status !== "authorized" || !consent.plaid_consent_id) {
    return { kind: "skipped", reason: "no authorised consent" };
  }

  // Insert first — the DB UNIQUE(idempotency_key) is the double-collection guard.
  let payment: Payment;
  try {
    payment = await insertPayment(db, {
      borrowerId: input.borrowerId,
      consentId: consent.id,
      idempotencyKey: input.idempotencyKey,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "GBP",
      reference: input.reference,
      scheduledFor: input.scheduledFor ?? null,
      retryOf: input.retryOf ?? null,
    });
  } catch (e) {
    if (e instanceof DuplicatePaymentError) {
      return { kind: "duplicate", idempotencyKey: input.idempotencyKey };
    }
    throw e;
  }

  // Execute against Plaid.
  try {
    const plaidConsentId = await decryptString(consent.plaid_consent_id, encryptionKey);
    const result = await plaid.executePayment({
      consentId: plaidConsentId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "GBP",
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
    });

    await setPaymentPlaidId(db, payment.id, result.paymentId);
    const internal = mapPlaidStatus(result.status) ?? "submitted";
    await updatePaymentStatus(db, payment.id, internal, {
      submittedAt: new Date().toISOString(),
    });

    await writeAudit(db, {
      actorStaffId: input.actorStaffId,
      action: "payment.execute",
      entityType: "payment",
      entityId: payment.id,
      metadata: {
        borrowerId: input.borrowerId,
        amountMinor: input.amountMinor,
        plaidStatus: result.status,
        internal,
        mode: plaid.mode,
      },
    });

    // Return the payment reflecting its final internal status (not the inserted 'pending').
    const updated = (await getPayment(db, payment.id)) ?? payment;
    return { kind: "collected", payment: updated, plaidStatus: result.status };
  } catch (e) {
    const reason = e instanceof PlaidApiError ? `${e.code}: ${e.message}` : String(e);
    await updatePaymentStatus(db, payment.id, "failed", { failureReason: reason });
    await writeAudit(db, {
      actorStaffId: input.actorStaffId,
      action: "payment.execute.error",
      entityType: "payment",
      entityId: payment.id,
      metadata: { reason },
    });

    // Notify the borrower that this collection failed. Best-effort: the internal
    // failure reason is never included in the email. Skip when no contact_email.
    if (mailer && borrower.contact_email) {
      const { subject, text } = failureEmail({
        borrowerName: borrower.legal_name,
        amountMinor: input.amountMinor,
        currency: input.currency ?? "GBP",
        reference: input.reference,
      });
      const emailResult = await mailer.send({ to: borrower.contact_email, subject, text });
      await writeAudit(db, {
        actorStaffId: input.actorStaffId,
        action: "email.failure",
        entityType: "payment",
        entityId: payment.id,
        metadata: { mode: mailer.mode, ok: emailResult.ok, to: borrower.contact_email },
      });
    }

    return { kind: "failed", payment, reason };
  }
}
