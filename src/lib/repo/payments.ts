import type { Payment, PaymentStatus } from "@/lib/types";
import { newId } from "@/lib/ids";

export class DuplicatePaymentError extends Error {
  constructor(public idempotencyKey: string) {
    super(`payment with idempotency_key already exists: ${idempotencyKey}`);
  }
}

/**
 * Insert a payment attempt. The DB UNIQUE(idempotency_key) constraint is the
 * authoritative double-collection guard: a duplicate key throws
 * DuplicatePaymentError instead of creating a second payment.
 */
export async function insertPayment(
  db: D1Database,
  data: {
    borrowerId: string;
    consentId: string | null;
    idempotencyKey: string;
    amountMinor: number;
    currency?: string;
    reference?: string | null;
    scheduledFor?: string | null;
    retryOf?: string | null;
  },
): Promise<Payment> {
  const id = newId();
  try {
    await db
      .prepare(
        `INSERT INTO payments
          (id, borrower_id, consent_id, idempotency_key, amount_minor, currency,
           reference, status, scheduled_for, retry_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        data.borrowerId,
        data.consentId,
        data.idempotencyKey,
        data.amountMinor,
        data.currency ?? "GBP",
        data.reference ?? null,
        data.scheduledFor ?? null,
        data.retryOf ?? null,
      )
      .run();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("UNIQUE") && msg.includes("idempotency_key")) {
      throw new DuplicatePaymentError(data.idempotencyKey);
    }
    throw e;
  }
  return (await getPayment(db, id))!;
}

export async function getPayment(db: D1Database, id: string): Promise<Payment | null> {
  return db.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<Payment>();
}

export async function getPaymentByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<Payment | null> {
  return db
    .prepare("SELECT * FROM payments WHERE idempotency_key = ?")
    .bind(key)
    .first<Payment>();
}

export async function getPaymentByPlaidId(
  db: D1Database,
  plaidPaymentId: string,
): Promise<Payment | null> {
  return db
    .prepare("SELECT * FROM payments WHERE plaid_payment_id = ?")
    .bind(plaidPaymentId)
    .first<Payment>();
}

export async function setPaymentPlaidId(
  db: D1Database,
  id: string,
  plaidPaymentId: string,
): Promise<void> {
  await db
    .prepare("UPDATE payments SET plaid_payment_id = ? WHERE id = ?")
    .bind(plaidPaymentId, id)
    .run();
}

export async function updatePaymentStatus(
  db: D1Database,
  id: string,
  status: PaymentStatus,
  opts: { failureReason?: string | null; submittedAt?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE payments
       SET status = ?, last_status_at = ?,
           failure_reason = COALESCE(?, failure_reason),
           submitted_at = COALESCE(?, submitted_at)
       WHERE id = ?`,
    )
    .bind(status, now, opts.failureReason ?? null, opts.submittedAt ?? null, id)
    .run();
}

export async function listPaymentsForBorrower(
  db: D1Database,
  borrowerId: string,
  limit = 100,
): Promise<Payment[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM payments WHERE borrower_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(borrowerId, Math.min(limit, 500))
    .all<Payment>();
  return results ?? [];
}

export async function listPayments(
  db: D1Database,
  opts: { status?: PaymentStatus | "all"; limit?: number } = {},
): Promise<Payment[]> {
  let sql = "SELECT * FROM payments";
  const binds: unknown[] = [];
  if (opts.status && opts.status !== "all") {
    sql += " WHERE status = ?";
    binds.push(opts.status);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(Math.min(opts.limit ?? 200, 500));
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Payment>();
  return results ?? [];
}

/** Count succeeded payments and total collected for a borrower (for schedule end logic). */
export async function collectionProgress(
  db: D1Database,
  borrowerId: string,
): Promise<{ paymentsMade: number; collectedMinor: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
       FROM payments
       WHERE borrower_id = ? AND status IN ('submitted','initiated','executed','settled')`,
    )
    .bind(borrowerId)
    .first<{ n: number; total: number }>();
  return { paymentsMade: row?.n ?? 0, collectedMinor: row?.total ?? 0 };
}
