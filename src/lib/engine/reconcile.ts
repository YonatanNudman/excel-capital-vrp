import { decryptString } from "@/lib/crypto";
import { mapPlaidStatus } from "@/lib/payment-state";
import type { PlaidClient } from "@/lib/plaid";
import { writeAudit } from "@/lib/repo/audit";
import { getConsent } from "@/lib/repo/consents";
import {
  applyPaymentTransition,
  dueForReconciliation,
  scheduleNextReconciliation,
  setPaymentProviderResult,
} from "@/lib/repo/payments";
import type { Payment } from "@/lib/types";

export interface ReconciliationSummary {
  considered: number;
  matched: number;
  updated: number;
  deferred: number;
  errors: number;
}

/** Resolve uncertain and in-flight attempts without ever creating a new charge. */
export async function reconcilePayments(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  now = new Date(),
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    considered: 0,
    matched: 0,
    updated: 0,
    deferred: 0,
    errors: 0,
  };
  const payments = await dueForReconciliation(db, now.toISOString());

  for (const payment of payments) {
    summary.considered++;
    try {
      const provider = payment.plaid_payment_id
        ? await plaid.getPayment(payment.plaid_payment_id)
        : await findLostPayment(db, plaid, encryptionKey, payment);

      if (!provider) {
        await defer(db, payment, now);
        summary.deferred++;
        continue;
      }
      summary.matched++;

      const next = mapPlaidStatus(provider.status);
      if (!next) {
        await defer(db, payment, now);
        summary.deferred++;
        continue;
      }

      if (!payment.plaid_payment_id) {
        const applied = await setPaymentProviderResult(db, payment.id, {
          plaidPaymentId: provider.paymentId,
          providerRequestId: "requestId" in provider ? provider.requestId : null,
          status: next,
        });
        if (applied) summary.updated++;
      } else {
        const transition = await applyPaymentTransition(db, payment.id, next, {
          failureReason: next === "failed" || next === "rejected" ? provider.status : null,
          providerRequestId: "requestId" in provider ? provider.requestId : null,
          providerChecked: true,
        });
        if (transition?.applied) summary.updated++;
      }

      if (["pending", "unknown", "submitted", "initiated", "executed"].includes(next)) {
        await defer(db, payment, now);
      }
      await writeAudit(db, {
        actorStaffId: null,
        action: "payment.reconcile",
        entityType: "payment",
        entityId: payment.id,
        metadata: { providerStatus: provider.status, internalStatus: next, ...summary},
      });
    } catch (error) {
      summary.errors++;
      await defer(db, payment, now);
      console.error(`payment reconciliation failed for ${payment.id}`, error);
    }
  }

  return summary;
}

async function findLostPayment(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  payment: Payment,
) {
  if (!payment.consent_id || !payment.reference) return null;
  const consent = await getConsent(db, payment.consent_id);
  if (!consent?.plaid_consent_id) return null;
  const consentId = await decryptString(consent.plaid_consent_id, encryptionKey);
  const candidates = await plaid.listPayments(consentId);
  return candidates.find(
    (candidate) =>
      candidate.reference === payment.reference &&
      (candidate.amountMinor == null || candidate.amountMinor === payment.amount_minor) &&
      (candidate.currency == null || candidate.currency === payment.currency),
  ) ?? null;
}

async function defer(db: D1Database, payment: Payment, now: Date): Promise<void> {
  const exponent = Math.min(payment.reconciliation_attempts, 8);
  const delayMs = Math.min(60_000 * 2 ** exponent, 6 * 60 * 60 * 1000);
  await scheduleNextReconciliation(db, payment.id, new Date(now.getTime() + delayMs).toISOString());
}
