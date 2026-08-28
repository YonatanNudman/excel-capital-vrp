import type { Payment, PaymentStatus } from "@/lib/types";
import { canTransition } from "@/lib/payment-state";
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
    scheduleId?: string | null;
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
          (id, borrower_id, consent_id, schedule_id, idempotency_key, amount_minor,
           currency, reference, status, scheduled_for, retry_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        data.borrowerId,
        data.consentId,
        data.scheduleId ?? null,
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

/**
 * Today's collection for this loan, if one has already been made.
 *
 * Matches across the schedule's whole lineage: an edit inserts a new row, and
 * without this an operator could edit a schedule after the morning's collection
 * and then take a second payment the same day, because the guard would be
 * looking for a schedule id that no longer existed when the payment was written.
 */
export async function getSchedulePaymentCreatedOn(
  db: D1Database,
  scheduleId: string,
  date: string,
): Promise<Payment | null> {
  return db
    .prepare(
      `SELECT * FROM payments
       WHERE ${LINEAGE_SQL} AND substr(created_at, 1, 10) = ?
         AND status NOT IN ('failed','rejected','cancelled')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(scheduleId, date)
    .first<Payment>();
}

export async function setPaymentProviderResult(
  db: D1Database,
  id: string,
  data: {
    plaidPaymentId: string;
    providerRequestId?: string | null;
    status: PaymentStatus;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE payments
       SET plaid_payment_id = ?, provider_request_id = ?, status = ?,
           submitted_at = COALESCE(submitted_at, ?), last_status_at = ?,
           last_provider_check_at = ?, reconcile_after = NULL,
           status_version = status_version + 1
       WHERE id = ? AND status IN ('pending','unknown')`,
    )
    .bind(
      data.plaidPaymentId,
      data.providerRequestId ?? null,
      data.status,
      now,
      now,
      now,
      id,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function markPaymentUnknown(
  db: D1Database,
  id: string,
  reason: string,
  plaidPaymentId?: string | null,
): Promise<void> {
  const now = new Date();
  const reconcileAfter = new Date(now.getTime() + 60_000).toISOString();
  await db
    .prepare(
      `UPDATE payments
       SET status = 'unknown', plaid_payment_id = COALESCE(?, plaid_payment_id),
           failure_reason = ?, last_status_at = ?, reconcile_after = ?,
           status_version = status_version + 1
       WHERE id = ? AND status NOT IN ('settled','rejected','cancelled')`,
    )
    .bind(plaidPaymentId ?? null, reason.slice(0, 500), now.toISOString(), reconcileAfter, id)
    .run();
}

export async function applyPaymentTransition(
  db: D1Database,
  id: string,
  next: PaymentStatus,
  opts: {
    failureReason?: string | null;
    providerRequestId?: string | null;
    providerChecked?: boolean;
  } = {},
): Promise<{ applied: boolean; from: PaymentStatus; current: PaymentStatus } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const payment = await getPayment(db, id);
    if (!payment) return null;
    if (!canTransition(payment.status, next)) {
      return { applied: false, from: payment.status, current: payment.status };
    }

    const now = new Date().toISOString();
    const terminal = ["settled", "failed", "rejected", "cancelled"].includes(next);
    const result = await db
      .prepare(
        `UPDATE payments
         SET status = ?, status_version = status_version + 1, last_status_at = ?,
             last_provider_check_at = CASE WHEN ? THEN ? ELSE last_provider_check_at END,
             provider_request_id = COALESCE(?, provider_request_id),
             failure_reason = ?, reconcile_after = CASE WHEN ? THEN NULL ELSE reconcile_after END
         WHERE id = ? AND status = ? AND status_version = ?`,
      )
      .bind(
        next,
        now,
        opts.providerChecked ? 1 : 0,
        now,
        opts.providerRequestId ?? null,
        opts.failureReason ?? null,
        terminal ? 1 : 0,
        id,
        payment.status,
        payment.status_version,
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      return { applied: true, from: payment.status, current: next };
    }
  }
  throw new Error(`payment transition contention exceeded for ${id}`);
}

export async function dueForReconciliation(
  db: D1Database,
  nowIso: string,
  limit = 100,
): Promise<Payment[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM payments
       WHERE status IN ('pending','unknown','submitted','initiated','executed')
         AND (reconcile_after IS NULL OR reconcile_after <= ?)
       ORDER BY COALESCE(reconcile_after, created_at) ASC
       LIMIT ?`,
    )
    .bind(nowIso, Math.min(Math.max(limit, 1), 500))
    .all<Payment>();
  return results ?? [];
}

export async function scheduleNextReconciliation(
  db: D1Database,
  id: string,
  afterIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE payments
       SET reconcile_after = ?, last_provider_check_at = ?,
           reconciliation_attempts = reconciliation_attempts + 1
       WHERE id = ?`,
    )
    .bind(afterIso, new Date().toISOString(), id)
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
  opts: {
    status?: PaymentStatus | "all";
    /** "problem" groups the statuses an operator actually chases. */
    group?: "problem" | null;
    borrowerId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  } = {},
): Promise<Payment[]> {
  let sql = "SELECT * FROM payments";
  const binds: unknown[] = [];
  const where: string[] = [];
  if (opts.status && opts.status !== "all") {
    where.push("status = ?");
    binds.push(opts.status);
  }
  if (opts.group === "problem") {
    where.push("status IN ('failed','rejected','unknown')");
  }
  if (opts.borrowerId) {
    where.push("borrower_id = ?");
    binds.push(opts.borrowerId);
  }
  // Dates are stored as ISO strings, so a lexicographic compare on the first ten
  // characters is a correct date comparison.
  if (opts.from) {
    where.push("substr(created_at, 1, 10) >= ?");
    binds.push(opts.from);
  }
  if (opts.to) {
    where.push("substr(created_at, 1, 10) <= ?");
    binds.push(opts.to);
  }
  if (where.length > 0) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(Math.min(opts.limit ?? 200, 500));
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Payment>();
  return results ?? [];
}

export interface PaymentSummary {
  inFlightCount: number;
  inFlightMinor: number;
  settledCount: number;
  settledMinor: number;
  failedCount: number;
  failedMinor: number;
}

/** Aggregate totals for reconciliation (all borrowers). */
export async function paymentSummary(db: D1Database): Promise<PaymentSummary> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('pending','unknown','submitted','initiated','executed') THEN 1 ELSE 0 END),0) AS inflight_n,
         COALESCE(SUM(CASE WHEN status IN ('pending','unknown','submitted','initiated','executed') THEN amount_minor ELSE 0 END),0) AS inflight_m,
         COALESCE(SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END),0) AS settled_n,
         COALESCE(SUM(CASE WHEN status = 'settled' THEN amount_minor ELSE 0 END),0) AS settled_m,
         COALESCE(SUM(CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END),0) AS failed_n,
         COALESCE(SUM(CASE WHEN status IN ('failed','rejected') THEN amount_minor ELSE 0 END),0) AS failed_m
       FROM payments`,
    )
    .first<{
      inflight_n: number;
      inflight_m: number;
      settled_n: number;
      settled_m: number;
      failed_n: number;
      failed_m: number;
    }>();
  return {
    inFlightCount: row?.inflight_n ?? 0,
    inFlightMinor: row?.inflight_m ?? 0,
    settledCount: row?.settled_n ?? 0,
    settledMinor: row?.settled_m ?? 0,
    failedCount: row?.failed_n ?? 0,
    failedMinor: row?.failed_m ?? 0,
  };
}

/**
 * Every schedule row belonging to the same loan as `scheduleId`.
 *
 * Editing a schedule inserts a NEW row (upsertSchedule keeps the superseded one
 * so history survives), so "payments made under this schedule" had to stop
 * meaning "payments carrying this row's id" or an edit would reset the loan to
 * zero. lineage_id (migration 0010) is carried forward through every edit.
 *
 * Written as a subquery rather than a second round trip so progress stays one
 * statement: it is read on every collection, for every borrower, every night.
 */
const LINEAGE_SQL = `schedule_id IN (
        SELECT s.id FROM repayment_schedules s
         WHERE COALESCE(s.lineage_id, s.id) = (
           SELECT COALESCE(lineage_id, id) FROM repayment_schedules WHERE id = ?
         )
      )`;

/** Count succeeded payments and total collected for a borrower (for schedule end logic). */
export async function collectionProgress(
  db: D1Database,
  borrowerId: string,
  scheduleId?: string | null,
): Promise<{ paymentsMade: number; collectedMinor: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
       FROM payments
       WHERE borrower_id = ?
         AND (? IS NULL OR ${LINEAGE_SQL})
         AND status IN ('unknown','submitted','initiated','executed','settled')`,
    )
    .bind(borrowerId, scheduleId ?? null, scheduleId ?? null)
    .first<{ n: number; total: number }>();
  return { paymentsMade: row?.n ?? 0, collectedMinor: row?.total ?? 0 };
}
