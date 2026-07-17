import type { PlaidClient } from "@/lib/plaid";
import { getPlaidClient } from "@/lib/plaid";
import { collectPayment } from "@/lib/engine/collect";
import { dueSchedules, setScheduleNextRun } from "@/lib/repo/schedules";
import { toSpec } from "@/lib/repo/schedules";
import { getBorrower } from "@/lib/repo/borrowers";
import { getSettings } from "@/lib/repo/settings";
import { collectionProgress } from "@/lib/repo/payments";
import { nextRunDate, isEnded, amountForRun } from "@/lib/schedule";
import { scheduledKey } from "@/lib/idempotency";
import { buildReference } from "@/lib/reference";
import { writeAudit } from "@/lib/repo/audit";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";

export interface CronSummary {
  date: string;
  considered: number;
  collected: number;
  duplicate: number;
  skipped: number;
  failed: number;
  ended: number;
}

/**
 * Scan all due schedules and attempt one collection each. Safety properties:
 *  - each collection uses a DETERMINISTIC scheduledKey(borrower, schedule, dueDate),
 *    so a cron double-fire (or overlapping run) cannot double-collect — the DB
 *    UNIQUE(idempotency_key) rejects the duplicate.
 *  - paused / non-collectable borrowers are skipped and their next_run_date is
 *    left intact so they resume cleanly.
 *  - next_run_date only advances after an attempt was made for the due date.
 */
export async function runDueCollections(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  today: string,
): Promise<CronSummary> {
  const summary: CronSummary = {
    date: today,
    considered: 0,
    collected: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    ended: 0,
  };

  const settings = await getSettings(db);
  const due = await dueSchedules(db, today);

  for (const schedule of due) {
    summary.considered++;
    const dueDate = schedule.next_run_date!;
    const borrower = await getBorrower(db, schedule.borrower_id);
    if (!borrower) {
      summary.skipped++;
      continue;
    }

    const spec = toSpec(schedule);
    const progress = await collectionProgress(db, schedule.borrower_id);

    // Ended? Deactivate and stop.
    if (isEnded(spec, { ...progress, onDate: dueDate })) {
      await setScheduleNextRun(db, schedule.id, null);
      summary.ended++;
      continue;
    }

    const amountMinor = amountForRun(spec, progress.collectedMinor);
    if (amountMinor <= 0) {
      await setScheduleNextRun(db, schedule.id, null);
      summary.ended++;
      continue;
    }

    const reference = buildReference(settings.default_reference_format, {
      borrowerToken: (borrower.company_number || borrower.legal_name || borrower.id)
        .slice(0, 8)
        .toUpperCase(),
      seq: progress.paymentsMade + 1,
    });

    const outcome = await collectPayment(db, plaid, encryptionKey, {
      borrowerId: schedule.borrower_id,
      amountMinor,
      reference,
      idempotencyKey: scheduledKey(schedule.borrower_id, schedule.id, dueDate),
      scheduledFor: dueDate,
      actorStaffId: null,
    });

    if (outcome.kind === "skipped") {
      // e.g. paused / no consent — leave next_run_date so it retries next pass.
      summary.skipped++;
      continue;
    }
    if (outcome.kind === "collected") summary.collected++;
    else if (outcome.kind === "duplicate") summary.duplicate++;
    else if (outcome.kind === "failed") summary.failed++;

    // Advance to the next due date after this one.
    const newProgress = await collectionProgress(db, schedule.borrower_id);
    const next = nextRunDate(spec, {
      afterDate: dueDate,
      paymentsMade: newProgress.paymentsMade,
      collectedMinor: newProgress.collectedMinor,
    });
    await setScheduleNextRun(db, schedule.id, next);
  }

  await writeAudit(db, {
    actorStaffId: null,
    action: "cron.run",
    entityType: "cron",
    entityId: today,
    metadata: summary,
  });

  return summary;
}

/**
 * Full daily maintenance: expire/flag consents first (so collections against an
 * expired consent are blocked), then run due collections.
 */
export async function runDueCollectionsFromEnv(
  env: CloudflareEnv,
  today: string,
): Promise<CronSummary & { consentExpired: number; consentExpiringSoon: number }> {
  const maintenance = await runConsentMaintenance(env.DB, new Date(`${today}T06:00:00Z`));
  const collections = await runDueCollections(
    env.DB,
    getPlaidClient(env),
    env.APP_ENCRYPTION_KEY,
    today,
  );
  return {
    ...collections,
    consentExpired: maintenance.expired,
    consentExpiringSoon: maintenance.expiringSoon,
  };
}
