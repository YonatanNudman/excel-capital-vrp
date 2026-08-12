import type { Consent, ConsentStatus } from "@/lib/types";
import { newId } from "@/lib/ids";

/**
 * The borrower's PRIMARY mandate: the one belonging to their default account.
 *
 * Since migration 0007 a borrower can hold several mandates, so "active consent"
 * had to be given a single unambiguous meaning. Anchoring it to the default
 * account keeps every pre-existing caller correct, because a borrower with one
 * account has exactly one mandate and that account is their default.
 *
 * Callers that must honour an operator's explicit choice of destination should
 * use resolveCollectionDestination instead, which also proves ownership.
 */
export async function getActiveConsent(
  db: D1Database,
  borrowerId: string,
): Promise<Consent | null> {
  // Prefer an authorised mandate on the default account, then any authorised
  // mandate, then the most recent of anything. The ordering matters during
  // re-consent, when a revoked mandate and a fresh pending one coexist.
  const preferred = await db
    .prepare(
      `SELECT c.* FROM consents c
         LEFT JOIN recipients r ON r.id = c.recipient_id
        WHERE c.borrower_id = ? AND c.status = 'authorized'
        ORDER BY COALESCE(r.is_default, 0) DESC, c.created_at DESC
        LIMIT 1`,
    )
    .bind(borrowerId)
    .first<Consent>();
  if (preferred) return preferred;
  return db
    .prepare(
      `SELECT c.* FROM consents c
         LEFT JOIN recipients r ON r.id = c.recipient_id
        WHERE c.borrower_id = ?
        ORDER BY COALESCE(r.is_default, 0) DESC, c.created_at DESC
        LIMIT 1`,
    )
    .bind(borrowerId)
    .first<Consent>();
}

/** The mandate for one specific account, preferring an authorised one. */
export async function getConsentForRecipient(
  db: D1Database,
  recipientId: string,
): Promise<Consent | null> {
  return db
    .prepare(
      `SELECT * FROM consents WHERE recipient_id = ?
        ORDER BY (status = 'authorized') DESC, created_at DESC LIMIT 1`,
    )
    .bind(recipientId)
    .first<Consent>();
}

/**
 * Mandates still awaiting the borrower's approval, oldest first.
 *
 * The setup page walks this list so the borrower approves every account in one
 * sitting. Ordered by the account list rather than by consent age so the
 * borrower sees "account 1 of 2" in the same order staff configured them.
 */
export async function pendingConsentsForBorrower(
  db: D1Database,
  borrowerId: string,
): Promise<Consent[]> {
  const { results } = await db
    .prepare(
      `SELECT c.* FROM consents c
         LEFT JOIN recipients r ON r.id = c.recipient_id
        WHERE c.borrower_id = ? AND c.status = 'pending'
          AND (r.archived_at IS NULL OR r.id IS NULL)
        ORDER BY COALESCE(r.is_default, 0) DESC, r.created_at ASC, c.created_at ASC`,
    )
    .bind(borrowerId)
    .all<Consent>();
  return results ?? [];
}

/** Bind a mandate to the account it pays into. Set once, before authorisation. */
export async function setConsentRecipient(
  db: D1Database,
  consentId: string,
  recipientId: string,
): Promise<void> {
  await db
    .prepare("UPDATE consents SET recipient_id = ? WHERE id = ? AND status <> 'authorized'")
    .bind(recipientId, consentId)
    .run();
}

export async function getConsent(db: D1Database, id: string): Promise<Consent | null> {
  return db.prepare("SELECT * FROM consents WHERE id = ?").bind(id).first<Consent>();
}

export interface ConsentLimits {
  /** The account this mandate pays into. Null only for legacy single-account rows. */
  recipientId?: string | null;
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
  for (const amount of [limits.maxPaymentAmountMinor, limits.periodicMaxAmountMinor]) {
    if (amount != null && (!Number.isSafeInteger(amount) || amount <= 0)) {
      throw new Error("consent limits must be positive integer minor-unit amounts");
    }
  }
  if (limits.validFrom && Number.isNaN(Date.parse(limits.validFrom))) {
    throw new Error("invalid consent start date");
  }
  if (limits.validTo && Number.isNaN(Date.parse(limits.validTo))) {
    throw new Error("invalid consent end date");
  }
  if (limits.validFrom && limits.validTo && Date.parse(limits.validTo) <= Date.parse(limits.validFrom)) {
    throw new Error("consent end date must be after its start date");
  }
  const id = newId();
  await db
    .prepare(
      `INSERT INTO consents
        (id, borrower_id, recipient_id, status, currency, max_payment_amount_minor, period,
         periodic_alignment, periodic_max_amount_minor, valid_from, valid_to)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      borrowerId,
      limits.recipientId ?? null,
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
    plaidConsentIdHash?: string | null;
    rawConstraints?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE consents SET plaid_consent_id = ?, plaid_consent_id_hash = ?,
         plaid_recipient_id = ?, raw_constraints = ? WHERE id = ?`,
    )
    .bind(
      data.plaidConsentIdEncrypted,
      data.plaidConsentIdHash ?? null,
      data.plaidRecipientId,
      data.rawConstraints != null ? JSON.stringify(data.rawConstraints) : null,
      id,
    )
    .run();
}

export async function getConsentByPlaidHash(
  db: D1Database,
  hash: string,
): Promise<Consent | null> {
  return db
    .prepare("SELECT * FROM consents WHERE plaid_consent_id_hash = ?")
    .bind(hash)
    .first<Consent>();
}

export async function listConsentsMissingPlaidHash(db: D1Database): Promise<Consent[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM consents
       WHERE plaid_consent_id IS NOT NULL AND plaid_consent_id_hash IS NULL
       LIMIT 500`,
    )
    .all<Consent>();
  return results ?? [];
}

export async function setConsentPlaidHash(
  db: D1Database,
  id: string,
  hash: string,
): Promise<void> {
  await db.prepare("UPDATE consents SET plaid_consent_id_hash = ? WHERE id = ?")
    .bind(hash, id)
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

/**
 * Replace the limits on a consent that has NOT been authorised yet.
 *
 * Deliberately refuses to touch an authorised consent: those constraints are
 * fixed at the bank once the borrower approves them, so editing our copy would
 * silently disagree with what the borrower actually agreed to. Changing limits
 * after authorisation requires a fresh consent (the re-consent flow).
 */
export async function updateUnauthorisedConsentLimits(
  db: D1Database,
  consentId: string,
  limits: {
    maxPaymentAmountMinor: number;
    periodicMaxAmountMinor: number;
    period: string;
    validTo?: string | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE consents
          SET max_payment_amount_minor = ?,
              periodic_max_amount_minor = ?,
              period = ?,
              valid_to = COALESCE(?, valid_to)
        WHERE id = ? AND status <> 'authorized'`,
    )
    .bind(
      limits.maxPaymentAmountMinor,
      limits.periodicMaxAmountMinor,
      limits.period,
      limits.validTo ?? null,
      consentId,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}
