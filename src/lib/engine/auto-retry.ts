import type { PlaidClient } from "@/lib/plaid";
import { collectPayment, type CollectInput, type CollectOutcome } from "@/lib/engine/collect";
import { getSettings } from "@/lib/repo/settings";
import { retryKey } from "@/lib/idempotency";
import { writeAudit } from "@/lib/repo/audit";
import { uniqueReferenceFromBase } from "@/lib/reference";
import type { Payment } from "@/lib/types";

export interface AutoRetrySummary {
  considered: number;
  retried: number;
  duplicate: number;
  failed: number;
  skipped: number;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Daily auto-retry pass over failed payments. The cron calls this (wiring lives
 * in cron.ts). Every retry runs through collectPayment, the only money-moving
 * path, so all of its guards (paused borrower, unauthorised consent, and the
 * UNIQUE(idempotency_key) double-collection guard) are enforced here too.
 *
 * Safety property (do not regress): the idempotency key is the DETERMINISTIC
 * retryKey(root, attempt), never randomised. Two concurrent cron fires that see
 * the same DB state compute the same attempt number and therefore the same key,
 * so the DB UNIQUE constraint rejects the loser as a duplicate instead of
 * double-collecting.
 */
export async function runAutoRetries(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  now: Date,
  collector?: (input: CollectInput) => Promise<CollectOutcome>,
): Promise<AutoRetrySummary> {
  const summary: AutoRetrySummary = {
    considered: 0,
    retried: 0,
    duplicate: 0,
    failed: 0,
    skipped: 0,
  };

  const settings = await getSettings(db);
  const spacingMs = settings.default_retry_spacing_hours * MS_PER_HOUR;

  // Candidates: failed payments that are the LATEST attempt in their retry chain
  // (chain root = retry_of ?? id). A row is "latest" when no sibling sharing its
  // root has a later created_at, with id as a tie-break so two same-timestamp
  // siblings can never both be selected in one pass (which would double-collect
  // one chain). Correlated NOT EXISTS, bound params only (no value interpolation).
  const { results } = await db
    .prepare(
      `SELECT p.*
         FROM payments p
        WHERE p.status = 'failed'
          AND NOT EXISTS (
            SELECT 1 FROM payments q
             WHERE COALESCE(q.retry_of, q.id) = COALESCE(p.retry_of, p.id)
               AND (q.created_at > p.created_at
                    OR (q.created_at = p.created_at AND q.id > p.id))
          )
        ORDER BY p.created_at ASC`,
    )
    .all<Payment>();

  const candidates = results ?? [];

  for (const candidate of candidates) {
    summary.considered++;
    const root = candidate.retry_of ?? candidate.id;

    // Attempts so far = retry rows already chained to this root (matches the
    // manual retryPaymentAction semantics). Read fresh so a concurrent double-fire
    // derives the same attempt number, and thus the same colliding key.
    const priorRetries = await db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE retry_of = ?")
      .bind(root)
      .first<{ n: number }>();
    const attempt = (priorRetries?.n ?? 0) + 1;

    // Retry budget exhausted: leave it alone (never reset or randomise the key).
    if (attempt > settings.default_retry_max) {
      summary.skipped++;
      continue;
    }

    // Spacing gate: the failure must have aged at least the configured window.
    // last_status_at is set when collectPayment marks the row failed; fall back to
    // created_at defensively.
    const basis = candidate.last_status_at ?? candidate.created_at;
    const ageMs = now.getTime() - Date.parse(basis);
    if (ageMs < spacingMs) {
      summary.skipped++;
      continue;
    }

    const input: CollectInput = {
      borrowerId: candidate.borrower_id,
      amountMinor: candidate.amount_minor,
      currency: candidate.currency,
      reference: uniqueReferenceFromBase(candidate.reference ?? "ExcelPayment", retryKey(root, attempt)),
      idempotencyKey: retryKey(root, attempt),
      // Same account as the attempt being retried, never the default. See the
      // matching note in retryPaymentAction.
      consentId: candidate.consent_id,
      scheduleId: candidate.schedule_id,
      retryOf: root,
      actorStaffId: null,
    };
    const outcome = collector
      ? await collector(input)
      : await collectPayment(db, plaid, encryptionKey, input);

    switch (outcome.kind) {
      case "collected":
        summary.retried++;
        break;
      case "duplicate":
        summary.duplicate++;
        break;
      case "failed":
        summary.failed++;
        break;
      case "unknown":
        summary.skipped++;
        break;
      case "skipped":
        summary.skipped++;
        break;
    }

    await writeAudit(db, {
      actorStaffId: null,
      action: "payment.auto_retry",
      entityType: "payment",
      entityId: root,
      metadata: { attemptNum: attempt, outcome: outcome.kind, ...summary},
    });
  }

  return summary;
}
