import type { Consent, ConsentStatus } from "@/lib/types";
import { newId } from "@/lib/ids";

export async function getActiveConsent(
  db: D1Database,
  borrowerId: string,
): Promise<Consent | null> {
  // Prefer an authorized consent; otherwise the most recent.
  const authorized = await db
    .prepare(
      "SELECT * FROM consents WHERE borrower_id = ? AND status = 'authorized' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(borrowerId)
    .first<Consent>();
  if (authorized) return authorized;
  return db
    .prepare("SELECT * FROM consents WHERE borrower_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(borrowerId)
    .first<Consent>();
}

export async function getConsent(db: D1Database, id: string): Promise<Consent | null> {
  return db.prepare("SELECT * FROM consents WHERE id = ?").bind(id).first<Consent>();
}

export interface ConsentLimits {
  currency?: string;
  maxPaymentAmountMinor?: number | null;
  period?: string | null;
  periodicAlignment?: string | null;
  periodicMaxAmountMinor?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
}

/** Create a pending consent capturing the intended limits (before Plaid auth). */
export async function createPendingConsent(
  db: D1Database,
  borrowerId: string,
  limits: ConsentLimits,
): Promise<Consent> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO consents
        (id, borrower_id, status, currency, max_payment_amount_minor, period,
         periodic_alignment, periodic_max_amount_minor, valid_from, valid_to)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      borrowerId,
      limits.currency ?? "GBP",
      limits.maxPaymentAmountMinor ?? null,
      limits.period ?? null,
      limits.periodicAlignment ?? null,
      limits.periodicMaxAmountMinor ?? null,
      limits.validFrom ?? null,
      limits.validTo ?? null,
    )
    .run();
  return (await getConsent(db, id))!;
}

export async function attachPlaidConsent(
  db: D1Database,
  id: string,
  data: {
    plaidConsentIdEncrypted: string;
    plaidRecipientId: string;
    rawConstraints?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE consents SET plaid_consent_id = ?, plaid_recipient_id = ?, raw_constraints = ? WHERE id = ?`,
    )
    .bind(
      data.plaidConsentIdEncrypted,
      data.plaidRecipientId,
      data.rawConstraints != null ? JSON.stringify(data.rawConstraints) : null,
      id,
    )
    .run();
}

/** Authorised consents whose valid_to has already passed. */
export async function overdueConsents(db: D1Database, nowIso: string): Promise<Consent[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM consents WHERE status = 'authorized' AND valid_to IS NOT NULL AND valid_to < ?",
    )
    .bind(nowIso)
    .all<Consent>();
  return results ?? [];
}

/** Authorised consents expiring within the given window (not yet overdue). */
export async function consentsExpiringSoon(
  db: D1Database,
  nowIso: string,
  untilIso: string,
): Promise<Consent[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM consents
       WHERE status = 'authorized' AND valid_to IS NOT NULL
         AND valid_to >= ? AND valid_to <= ?`,
    )
    .bind(nowIso, untilIso)
    .all<Consent>();
  return results ?? [];
}

export async function setConsentStatus(
  db: D1Database,
  id: string,
  status: ConsentStatus,
  authorizedAt?: string,
): Promise<void> {
  if (status === "authorized") {
    await db
      .prepare("UPDATE consents SET status = ?, authorized_at = ? WHERE id = ?")
      .bind(status, authorizedAt ?? new Date().toISOString(), id)
      .run();
  } else {
    await db
      .prepare("UPDATE consents SET status = ? WHERE id = ?")
      .bind(status, id)
      .run();
  }
}
