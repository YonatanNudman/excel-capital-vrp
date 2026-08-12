import { decryptString } from "@/lib/crypto";
import { failureEmail } from "@/lib/mailer/templates";
import type { Mailer } from "@/lib/mailer";
import { mapPlaidStatus } from "@/lib/payment-state";
import { PlaidApiError, PlaidTransportError, type PlaidClient } from "@/lib/plaid";
import { writeAudit } from "@/lib/repo/audit";
import { getBorrower } from "@/lib/repo/borrowers";
import { resolveCollectionDestination } from "@/lib/repo/destinations";
import {
  completePaymentIntent,
  setPaymentIntentExecuting,
} from "@/lib/repo/payment-intents";
import {
  DuplicatePaymentError,
  applyPaymentTransition,
  getPayment,
  insertPayment,
  markPaymentUnknown,
  setPaymentProviderResult,
} from "@/lib/repo/payments";
import type { Payment, PaymentStatus } from "@/lib/types";

export type CollectOutcome =
  | { kind: "duplicate"; idempotencyKey: string }
  | { kind: "skipped"; reason: string }
  | { kind: "collected"; payment: Payment; plaidStatus: string }
  | { kind: "unknown"; payment: Payment; reason: string }
  | { kind: "failed"; payment: Payment; reason: string };

export interface CollectInput {
  borrowerId: string;
  amountMinor: number;
  currency?: string;
  reference: string;
  idempotencyKey: string;
  /**
   * Which mandate to collect against, and therefore which bank account the money
   * lands in. Untrusted: it originates from a form, and is re-checked against
   * this borrower's own destinations below. Omit for the default account.
   */
  consentId?: string | null;
  scheduleId?: string | null;
  intentId?: string | null;
  scheduledFor?: string | null;
  retryOf?: string | null;
  actorStaffId: string | null;
}

/**
 * The only provider payment execution path. A persisted row and stable
 * idempotency key always exist before the network call. Ambiguous outcomes are
 * quarantined as `unknown` for reconciliation and are never auto-retried.
 */
export async function collectPayment(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  input: CollectInput,
  mailer?: Mailer,
): Promise<CollectOutcome> {
  const currency = input.currency ?? "GBP";
  const invalid = validateInput(input.amountMinor, currency, input.reference, input.idempotencyKey);
  if (invalid) return { kind: "skipped", reason: invalid };

  const borrower = await getBorrower(db, input.borrowerId);
  if (!borrower) return { kind: "skipped", reason: "borrower not found" };
  if (borrower.status === "paused") return { kind: "skipped", reason: "collections paused" };
  if (borrower.status === "revoked" || borrower.status === "expired") {
    return { kind: "skipped", reason: `consent ${borrower.status}` };
  }

  // Resolve the destination HERE rather than trusting the caller. input.consentId
  // arrives from a form, so this is the check that stops one borrower's money
  // being collected into another borrower's mandate. It also verifies the mandate
  // is authorised and provisioned, replacing the old getActiveConsent guard.
  const resolved = await resolveCollectionDestination(db, input.borrowerId, input.consentId);
  if (!resolved.ok) return { kind: "skipped", reason: resolved.reason };
  const consent = resolved.destination.consent;
  // resolveDestination already guarantees both of these, but re-check rather than
  // asserting: this is the last point before a real payment row is written, and a
  // future change to the resolver must not be able to reach the provider without
  // a mandate to execute against.
  if (!consent || !consent.plaid_consent_id) {
    return { kind: "skipped", reason: "no authorised consent" };
  }

  const now = new Date();
  if (consent.valid_from && now < new Date(consent.valid_from)) {
    return { kind: "skipped", reason: "consent is not yet valid" };
  }
  if (consent.valid_to && now > new Date(consent.valid_to)) {
    return { kind: "skipped", reason: "consent expired" };
  }
  if (
    consent.max_payment_amount_minor != null &&
    input.amountMinor > consent.max_payment_amount_minor
  ) {
    return { kind: "skipped", reason: "amount exceeds consent limit" };
  }

  let payment: Payment;
  try {
    payment = await insertPayment(db, {
      borrowerId: input.borrowerId,
      consentId: consent.id,
      scheduleId: input.scheduleId,
      idempotencyKey: input.idempotencyKey,
      amountMinor: input.amountMinor,
      currency,
      reference: input.reference,
      scheduledFor: input.scheduledFor ?? null,
      retryOf: input.retryOf ?? null,
    });
  } catch (error) {
    if (error instanceof DuplicatePaymentError) {
      return { kind: "duplicate", idempotencyKey: input.idempotencyKey };
    }
    throw error;
  }

  if (input.intentId) await setPaymentIntentExecuting(db, input.intentId);

  let result: Awaited<ReturnType<PlaidClient["executePayment"]>>;
  try {
    const plaidConsentId = await decryptString(consent.plaid_consent_id, encryptionKey);
    result = await plaid.executePayment({
      consentId: plaidConsentId,
      amountMinor: input.amountMinor,
      currency,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (isDefinitiveRejection(error)) {
      const reason = providerErrorReason(error);
      const failureStatus: PaymentStatus = isConfirmedPaymentFailure(error) ? "failed" : "rejected";
      await applyPaymentTransition(db, payment.id, failureStatus, {
        failureReason: reason,
        providerRequestId: error.requestId,
        providerChecked: true,
      });
      const updated = (await getPayment(db, payment.id)) ?? payment;
      await auditExecution(db, input, updated.id, "payment.execute.rejected", {
        reason,
        providerRequestId: error.requestId,
      });
      await sendFailureEmail(db, mailer, borrower, updated, input.actorStaffId);
      await finishIntent(db, input.intentId, updated.id);
      return { kind: "failed", payment: updated, reason };
    }

    const reason = providerErrorReason(error);
    await markPaymentUnknown(db, payment.id, reason);
    const updated = (await getPayment(db, payment.id)) ?? payment;
    await auditExecution(db, input, updated.id, "payment.execute.unknown", { reason });
    await finishIntent(db, input.intentId, updated.id);
    return { kind: "unknown", payment: updated, reason };
  }

  const internal = mapPlaidStatus(result.status) ?? "unknown";
  try {
    await setPaymentProviderResult(db, payment.id, {
      plaidPaymentId: result.paymentId,
      providerRequestId: result.requestId,
      status: internal,
    });
  } catch (error) {
    // The provider accepted the idempotent request but local persistence failed.
    // Never describe this as failed or permit a fresh-key retry.
    try {
      await markPaymentUnknown(db, payment.id, providerErrorReason(error), result.paymentId);
    } catch {
      // Preserve the original persistence failure for platform error reporting.
    }
    throw error;
  }

  const updated = (await getPayment(db, payment.id)) ?? payment;
  await auditExecution(db, input, updated.id, "payment.execute", {
    amountMinor: input.amountMinor,
    plaidStatus: result.status,
    internal,
    providerRequestId: result.requestId,
    mode: plaid.mode,
  });
  await finishIntent(db, input.intentId, updated.id);

  if (internal === "failed" || internal === "rejected") {
    await sendFailureEmail(db, mailer, borrower, updated, input.actorStaffId);
    return { kind: "failed", payment: updated, reason: result.status };
  }
  if (internal === "unknown") {
    return { kind: "unknown", payment: updated, reason: `unmapped provider status ${result.status}` };
  }
  return { kind: "collected", payment: updated, plaidStatus: result.status };
}

function validateInput(
  amountMinor: number,
  currency: string,
  reference: string,
  idempotencyKey: string,
): string | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return "invalid payment amount";
  if (currency !== "GBP") return "unsupported payment currency";
  if (!/^[A-Za-z0-9]{1,18}$/.test(reference)) return "invalid payment reference";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) return "invalid idempotency key";
  return null;
}

function isDefinitiveRejection(error: unknown): error is PlaidApiError {
  return error instanceof PlaidApiError && error.httpStatus >= 400 && error.httpStatus < 500 &&
    error.httpStatus !== 408 && error.httpStatus !== 429;
}

function isConfirmedPaymentFailure(error: PlaidApiError): boolean {
  return error.code.includes("INSUFFICIENT_FUNDS") || error.code.includes("PAYMENT_STATUS_FAILED");
}

function providerErrorReason(error: unknown): string {
  if (error instanceof PlaidApiError) return `${error.code}: ${error.message}`.slice(0, 500);
  if (error instanceof PlaidTransportError) return `transport: ${error.message}`.slice(0, 500);
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function auditExecution(
  db: D1Database,
  input: CollectInput,
  paymentId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await writeAudit(db, {
      actorStaffId: input.actorStaffId,
      action,
      entityType: "payment",
      entityId: paymentId,
      metadata: { borrowerId: input.borrowerId, ...metadata },
    });
  } catch (error) {
    console.error(`payment audit write failed for ${paymentId}`, error);
  }
}

async function finishIntent(
  db: D1Database,
  intentId: string | null | undefined,
  paymentId: string,
): Promise<void> {
  if (!intentId) return;
  try {
    await completePaymentIntent(db, intentId, paymentId);
  } catch (error) {
    console.error(`payment intent completion failed for ${paymentId}`, error);
  }
}

async function sendFailureEmail(
  db: D1Database,
  mailer: Mailer | undefined,
  borrower: { contact_email: string | null; legal_name: string },
  payment: Payment,
  actorStaffId: string | null,
): Promise<void> {
  if (!mailer || !borrower.contact_email) return;
  const { subject, text } = failureEmail({
    borrowerName: borrower.legal_name,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    reference: payment.reference ?? "",
  });
  try {
    const result = await mailer.send({ to: borrower.contact_email, subject, text });
    await writeAudit(db, {
      actorStaffId,
      action: "email.failure",
      entityType: "payment",
      entityId: payment.id,
      metadata: { mode: mailer.mode, ok: result.ok, to: borrower.contact_email },
    });
  } catch (error) {
    console.error(`failure notification failed for payment ${payment.id}`, error);
  }
}
