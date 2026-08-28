import type { PlaidClient } from "@/lib/plaid";
import { getPlaidClient } from "@/lib/plaid";
import { collectPayment, type CollectInput, type CollectOutcome } from "@/lib/engine/collect";
import { collectPaymentCoordinated } from "@/lib/durable/coordinated-collect";
import { dueSchedules, lineageOf, setScheduleNextRun } from "@/lib/repo/schedules";
import { toSpec } from "@/lib/repo/schedules";
import { getBorrower } from "@/lib/repo/borrowers";
import { getSettings } from "@/lib/repo/settings";
import { collectionProgress } from "@/lib/repo/payments";
import { nextRunDate, isEnded, amountForRun } from "@/lib/schedule";
import { scheduledKey } from "@/lib/idempotency";
import { buildUniqueReference } from "@/lib/reference";
import { writeAudit } from "@/lib/repo/audit";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";
import { runAutoRetries } from "@/lib/engine/auto-retry";
import { reconcilePayments } from "@/lib/engine/reconcile";
import { getMailer, type Mailer, type MailerEnv } from "@/lib/mailer";

/**
 * How far behind a due date may be and still be collected automatically.
 *
 * Chosen to clear one missed cycle of the longest ordinary frequency (monthly)
 * while refusing anything that looks like a backlog. Raising it hands the sweep
 * permission to take more money at once from a borrower who has been unable to
 * pay, which is exactly the decision that should stay with a person.
 */
const MAX_CATCHUP_DAYS = 35;

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function yesterdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface CronSummary {
  date: string;
  considered: number;
  collected: number;
  duplicate: number;
  skipped: number;
  failed: number;
  unknown: number;
  ended: number;
  /** Due dates abandoned as too old to collect without a human deciding. */
  stale: number;
  /** Schedules whose own processing threw. The rest of the sweep still ran. */
  errored: number;
}

/**
 * Scan all due schedules and attempt one collection each. Safety properties:
 *  - each collection uses a DETERMINISTIC scheduledKey(borrower, schedule, dueDate),
 *    so a cron double-fire (or overlapping run) cannot double-collect, the DB
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
  mailer?: Mailer,
  collector?: (input: CollectInput) => Promise<CollectOutcome>,
): Promise<CronSummary> {
  const summary: CronSummary = {
    date: today,
    considered: 0,
    collected: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    ended: 0,
    stale: 0,
    errored: 0,
  };

  const settings = await getSettings(db);
  const due = await dueSchedules(db, today);

  for (const schedule of due) {
    summary.considered++;
    try {
      const dueDate = schedule.next_run_date!;
      const borrower = await getBorrower(db, schedule.borrower_id);
      if (!borrower) {
        summary.skipped++;
        continue;
      }

      const spec = toSpec(schedule);
      const progress = await collectionProgress(db, schedule.borrower_id, schedule.id);

      // Ended? Deactivate and stop.
      if (isEnded(spec, { ...progress, onDate: dueDate })) {
        await setScheduleNextRun(db, schedule.id, null);
        summary.ended++;
        continue;
      }

      // Too far in the past to collect without a human deciding.
      //
      // A skipped collection deliberately leaves next_run_date where it is, so
      // nothing is forgotten, and a successful one advances by exactly one
      // interval. Together that means a schedule which has been unable to collect
      // for months comes back as one full debit per night until it catches up.
      // A borrower paused over a dispute, or an account retired while a schedule
      // still pointed at it, would be hit with the entire backlog the moment the
      // obstruction cleared, with nothing on screen having warned anyone.
      //
      // Anything older than this is re-anchored to the next future date and
      // recorded in the audit trail instead. Arrears are then a decision an
      // operator makes deliberately (a one-off collection), never something the
      // sweep does to a borrower overnight.
      if (daysBetween(dueDate, today) > MAX_CATCHUP_DAYS) {
        const reanchored = nextRunDate(spec, {
          afterDate: yesterdayOf(today),
          paymentsMade: progress.paymentsMade,
          collectedMinor: progress.collectedMinor,
        });
        await setScheduleNextRun(db, schedule.id, reanchored);
        summary.stale++;
        await writeAudit(db, {
          actorStaffId: null,
          action: "schedule.stale_run_skipped",
          entityType: "borrower",
          entityId: schedule.borrower_id,
          metadata: {
            scheduleId: schedule.id,
            skippedDueDate: dueDate,
            resumedFrom: reanchored,
            daysOverdue: daysBetween(dueDate, today),
          },
        });
        continue;
      }

      const amountMinor = amountForRun(spec, progress.collectedMinor);
      if (amountMinor <= 0) {
        await setScheduleNextRun(db, schedule.id, null);
        summary.ended++;
        continue;
      }

      // Keyed on the LINEAGE, not the row: editing a schedule inserts a new row,
      // and a row-keyed idempotency key made this morning's collection invisible
      // to tonight's sweep for the same due date.
      const idempotencyKey = scheduledKey(schedule.borrower_id, lineageOf(schedule), dueDate);
      const reference = buildUniqueReference(settings.default_reference_format, {
        borrowerToken: (borrower.company_number || borrower.legal_name || borrower.id)
          .slice(0, 8)
          .toUpperCase(),
        seq: progress.paymentsMade + 1,
      }, idempotencyKey);

      const collectionInput: CollectInput = {
        borrowerId: schedule.borrower_id,
        amountMinor,
        reference,
        idempotencyKey,
        // Where this schedule's money goes. Null means the borrower's default
        // account, which is every schedule created before multiple destinations
        // existed, so their behaviour is unchanged.
        consentId: schedule.consent_id,
        scheduleId: schedule.id,
        scheduledFor: dueDate,
        actorStaffId: null,
      };
      const outcome = collector
        ? await collector(collectionInput)
        : await collectPayment(db, plaid, encryptionKey, collectionInput, mailer);

      if (outcome.kind === "skipped") {
        // e.g. paused / no consent, leave next_run_date so it retries next pass.
        summary.skipped++;
        continue;
      }
      if (outcome.kind === "collected") summary.collected++;
      else if (outcome.kind === "duplicate") summary.duplicate++;
      else if (outcome.kind === "failed") summary.failed++;
      else if (outcome.kind === "unknown") summary.unknown++;

      // Advance to the next due date after this one.
      const newProgress = await collectionProgress(db, schedule.borrower_id, schedule.id);
      const next = nextRunDate(spec, {
        afterDate: dueDate,
        paymentsMade: newProgress.paymentsMade,
        collectedMinor: newProgress.collectedMinor,
      });
      await setScheduleNextRun(db, schedule.id, next);
    } catch (error) {
      // One borrower's problem must not cost every borrower after them in the
      // list their collection. Every other phase of the nightly run is already
      // isolated this way; this loop was the exception, so a single throw ended
      // the night silently, and the only trace was an unexplained short summary.
      summary.errored++;
      console.error(`collection failed for schedule ${schedule.id}`, error);
      await writeAudit(db, {
        actorStaffId: null,
        action: "cron.schedule_error",
        entityType: "borrower",
        entityId: schedule.borrower_id,
        metadata: {
          scheduleId: schedule.id,
          dueDate: schedule.next_run_date,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
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
 * Full daily maintenance, in a deliberate order:
 *  1. Consent maintenance first, so collections against an expired consent are
 *     blocked and borrowers nearing expiry get their one re-consent warning.
 *  2. Due collections (with borrower notifications on failure).
 *  3. Automatic retries of eligible failed payments per the retry policy.
 */
export async function runDueCollectionsFromEnv(
  env: CloudflareEnv,
  today: string,
): Promise<
  CronSummary & {
    consentExpired: number;
    consentRevokedAtBank: number;
    consentExpiringSoon: number;
    autoRetried: number;
    autoRetryFailed: number;
    reconciled: number;
    reconciliationErrors: number;
  }
> {
  const plaid = getPlaidClient(env);
  const mailer = getMailer(env as MailerEnv);
  const now = new Date(`${today}T06:00:00Z`);

  // Each phase is isolated: a failure in one is audited and must never stop the
  // others, so a single bad row cannot wedge a whole day's collections.
  const maintenance = await phase(env.DB, today, "consent_maintenance", () =>
    runConsentMaintenance(env.DB, now, mailer, plaid, env.APP_ENCRYPTION_KEY),
  );
  const collections = await phase(env.DB, today, "collections", () =>
    runDueCollections(
      env.DB,
      plaid,
      env.APP_ENCRYPTION_KEY,
      today,
      mailer,
      (input) => collectPaymentCoordinated(env, input),
    ),
  );
  const reconciliation = await phase(env.DB, today, "reconciliation", () =>
    reconcilePayments(env.DB, plaid, env.APP_ENCRYPTION_KEY, now),
  );
  const retries = await phase(env.DB, today, "auto_retries", () =>
    runAutoRetries(
      env.DB,
      plaid,
      env.APP_ENCRYPTION_KEY,
      now,
      (input) => collectPaymentCoordinated(env, input),
    ),
  );

  return {
    ...(collections ?? {
      date: today,
      considered: 0,
      collected: 0,
      duplicate: 0,
      skipped: 0,
      failed: 0,
      unknown: 0,
      ended: 0,
      stale: 0,
      errored: 0,
    }),
    consentExpired: maintenance?.expired ?? 0,
    consentRevokedAtBank: maintenance?.revokedAtBank ?? 0,
    consentExpiringSoon: maintenance?.expiringSoon ?? 0,
    autoRetried: retries?.retried ?? 0,
    autoRetryFailed: retries?.failed ?? 0,
    reconciled: reconciliation?.updated ?? 0,
    reconciliationErrors: reconciliation?.errors ?? 0,
  };
}

/** Run one cron phase; on error, audit it and return null instead of throwing. */
async function phase<T>(
  db: D1Database,
  today: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error(`cron phase ${name} failed`, e);
    await writeAudit(db, {
      actorStaffId: null,
      action: "cron.phase_error",
      entityType: "cron",
      entityId: today,
      metadata: { phase: name, error: String(e).slice(0, 500) },
    });
    return null;
  }
}
