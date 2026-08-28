"use server";

import { revalidatePath } from "next/cache";
import { getDb, getEnv } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import type { CollectOutcome } from "@/lib/engine/collect";
import { collectPaymentCoordinated } from "@/lib/durable/coordinated-collect";
import { getActiveSchedule, lineageOf, setScheduleNextRun } from "@/lib/repo/schedules";
import { toSpec } from "@/lib/repo/schedules";
import { getSettings } from "@/lib/repo/settings";
import { resolveCollectionDestination } from "@/lib/repo/destinations";
import { checkAmountAgainstConsent } from "@/lib/payment-limits";
import { getBorrower } from "@/lib/repo/borrowers";
import {
  collectionProgress,
  getPayment,
  getSchedulePaymentCreatedOn,
} from "@/lib/repo/payments";
import { createOrGetPaymentIntent } from "@/lib/repo/payment-intents";
import { manualKey, retryKey, scheduledKey } from "@/lib/idempotency";
import { buildUniqueReference, uniqueReferenceFromBase } from "@/lib/reference";
import { newId } from "@/lib/ids";
import { toMinorUnits } from "@/lib/money";
import { amountForRun, isEnded, nextRunDate } from "@/lib/schedule";

/**
 * Turn an engine outcome into something a non-technical operator can act on.
 * The tone drives the colour of the result banner, so "nothing bad happened"
 * never looks like a failure and vice versa.
 */
/**
 * Engine reasons are a mix of short fragments ("collections paused") and full
 * sentences from destination resolution ("The borrower has not approved this
 * account yet."). Trim the trailing stop so neither reads as "yet..".
 */
function reasonFragment(reason: string): string {
  return reason.trim().replace(/\.$/, "");
}

function outcomeMessage(o: CollectOutcome): ActionResult {
  switch (o.kind) {
    case "collected":
      return { message: "Payment sent to the bank. It will show below as it settles.", tone: "success" };
    case "duplicate":
      return { message: "This payment was already sent. Nothing was charged twice.", tone: "info" };
    case "skipped":
      return { message: `Nothing was sent: ${reasonFragment(o.reason)}.`, tone: "info" };
    case "failed":
      return { message: `The payment did not go through: ${reasonFragment(o.reason)}.`, tone: "error" };
    case "unknown":
      return {
        message:
          "The bank has not confirmed this one yet. We are checking. Do not send it again.",
        tone: "info",
      };
  }
}

/**
 * Run a collection and never let an infrastructure failure become a page crash.
 *
 * By the time we get here a payment intent exists, so a thrown error means we do
 * not know whether the provider was reached. The message therefore refuses to
 * imply failure and explicitly warns against a blind retry: reconciliation will
 * resolve a payment that did go out, and a second attempt could double-charge.
 */
async function collectOrReportUnknown(
  run: () => Promise<CollectOutcome>,
): Promise<ActionResult & { kind?: CollectOutcome["kind"] }> {
  try {
    const outcome = await run();
    return { ...outcomeMessage(outcome), kind: outcome.kind };
  } catch (error) {
    console.error("collection failed before an outcome was known", error);
    return {
      message:
        "We could not confirm whether this payment was sent. Check the Payments list before trying again, and do not send it a second time.",
      tone: "info",
    };
  }
}

async function borrowerToken(db: D1Database, borrowerId: string): Promise<string> {
  const b = await getBorrower(db, borrowerId);
  return (b?.company_number || b?.legal_name || borrowerId).slice(0, 8).toUpperCase();
}

export type ActionTone = "success" | "info" | "error";
export interface ActionResult {
  message: string;
  tone: ActionTone;
}
export type ActionState = ActionResult | null;

/** Manual one-off collection. Amount defaults to the active schedule amount. */
export async function executePaymentNowAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();
  const borrowerId = String(fd.get("borrowerId") ?? "");
  if (!borrowerId) return { message: "Something went wrong: no borrower was selected.", tone: "error" };
  if (String(env.COLLECTIONS_ENABLED) !== "true") {
    return { message: "Collections are switched off right now, so nothing was sent.", tone: "info" };
  }

  const overrideAmount = fd.get("amount");
  const schedule = await getActiveSchedule(db, borrowerId);

  // Which account this collection pays into. An explicit choice from the operator
  // wins; otherwise a scheduled run follows its schedule, and anything else falls
  // back to the borrower's default account. Ownership of a chosen id is proven
  // inside the engine, so nothing here has to trust it.
  const chosenDestination = String(fd.get("destinationConsentId") ?? "").trim();
  const destination = await resolveCollectionDestination(
    db,
    borrowerId,
    chosenDestination || schedule?.consent_id,
  );
  if (!destination.ok) return { message: destination.reason, tone: "error" };
  const destinationConsentId = destination.destination.consent!.id;
  const today = new Date().toISOString().slice(0, 10);
  // Collecting the scheduled amount IS a run of that schedule, whether or not the
  // due date has arrived yet.
  //
  // This used to require next_run_date <= today, which is false for most of the
  // week on any schedule the sweep has already advanced. An early press therefore
  // fell through to the ad-hoc path: the payment was written with schedule_id
  // NULL under a random per-render key, so (1) the "today's payment was already
  // sent" guard could not see it and a second press took the money again, (2) it
  // counted towards neither the loan total nor the payment count, so the schedule
  // ran past the agreed end, and (3) the sweep collected the same instalment
  // again on its due date. Treating it as the instalment it is gives it the
  // deterministic key, which makes all three impossible.
  const isScheduledRun =
    !(typeof overrideAmount === "string" && overrideAmount.trim()) &&
    Boolean(schedule?.next_run_date);
  if (
    schedule &&
    !(typeof overrideAmount === "string" && overrideAmount.trim()) &&
    await getSchedulePaymentCreatedOn(db, schedule.id, today)
  ) {
    return { message: "Today's payment was already sent. Nothing was charged twice.", tone: "info" };
  }
  let amountMinor: number | null = null;
  const isOneOff = typeof overrideAmount === "string" && overrideAmount.trim().length > 0;
  if (isOneOff) {
    const entered = Number(overrideAmount);
    if (!Number.isFinite(entered) || entered <= 0) {
      return { message: "Enter an amount greater than zero.", tone: "error" };
    }
    amountMinor = toMinorUnits(entered);
    // Tell the operator now if this breaches the mandate, rather than creating a
    // payment the bank will refuse.
    // Check against the mandate this money is actually going to. Each account has
    // its own caps, so checking the default's would clear an amount the chosen
    // account's bank then refuses.
    const problem = checkAmountAgainstConsent(amountMinor, destination.destination.consent);
    if (problem) return { message: problem, tone: "error" };
  } else {
    if (schedule && isScheduledRun) {
      const progress = await collectionProgress(db, borrowerId, schedule.id);
      // The final instalment of a 'total' loan is a remainder, not the full
      // amount, and collecting it early must not overshoot the agreed total.
      amountMinor = amountForRun(toSpec(schedule), progress.collectedMinor);
      if (isEnded(toSpec(schedule), { ...progress, onDate: today })) {
        return {
          message: "This loan has already been collected in full. Nothing was charged.",
          tone: "info",
        };
      }
    } else {
      amountMinor = schedule?.amount_minor ?? null;
    }
  }
  if (!amountMinor || amountMinor <= 0) {
    return { message: "No amount to collect. Add a repayment schedule first.", tone: "error" };
  }

  const settings = await getSettings(db);
  const { paymentsMade } = await collectionProgress(db, borrowerId, schedule?.id);

  const nonce = String(fd.get("nonce") ?? "") || newId();
  // Keyed on the schedule's LINEAGE and the date this instalment is FOR, so it
  // collides with the sweep's own key for that date however many times the
  // schedule has been edited since.
  const idempotencyKey = isScheduledRun && schedule
    ? scheduledKey(borrowerId, lineageOf(schedule), schedule.next_run_date!)
    : manualKey(borrowerId, nonce);
  const reason = String(fd.get("reason") ?? "").trim();
  const reference = isOneOff && reason
    ? uniqueReferenceFromBase(reason, idempotencyKey)
    : buildUniqueReference(settings.default_reference_format, {
        borrowerToken: await borrowerToken(db, borrowerId),
        seq: paymentsMade + 1,
      }, idempotencyKey);
  const intent = await createOrGetPaymentIntent(db, {
    id: nonce,
    borrowerId,
    scheduleId: isScheduledRun ? schedule?.id : null,
    kind: isScheduledRun ? "scheduled" : "manual",
    amountMinor,
    currency: "GBP",
    reference,
    idempotencyKey,
    createdBy: user.id,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });

  const result = await collectOrReportUnknown(() =>
    collectPaymentCoordinated(env, {
      borrowerId,
      amountMinor,
      reference,
      idempotencyKey,
      consentId: destinationConsentId,
      scheduleId: isScheduledRun ? schedule?.id : null,
      scheduledFor: isScheduledRun ? schedule?.next_run_date : null,
      intentId: intent.id,
      actorStaffId: user.id,
    }),
  );

  // Move the schedule on, exactly as the nightly sweep does after its own attempt.
  //
  // Without this, collecting today's payment by hand left next_run_date pointing
  // at the date just collected. The deterministic key means the sweep cannot
  // double-charge for it, but it would spend the next morning re-attempting a
  // date already paid, and every screen would keep showing a "next collection"
  // that had already happened. The schedule then trails a day behind for good.
  //
  // Skipped is excluded for the same reason the sweep excludes it: nothing was
  // attempted, so the date is still owed.
  if (isScheduledRun && schedule && result.kind && result.kind !== "skipped") {
    const after = await collectionProgress(db, borrowerId, schedule.id);
    await setScheduleNextRun(
      db,
      schedule.id,
      nextRunDate(toSpec(schedule), {
        afterDate: schedule.next_run_date!,
        paymentsMade: after.paymentsMade,
        collectedMinor: after.collectedMinor,
      }),
    );
  }

  revalidatePath(`/borrowers/${borrowerId}`);
  revalidatePath("/payments");
  return result;
}

/** Retry a failed payment as a distinct attempt (new idempotency key). */
export async function retryPaymentAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();
  if (String(env.COLLECTIONS_ENABLED) !== "true") {
    return { message: "Collections are switched off right now, so nothing was sent.", tone: "info" };
  }
  const paymentId = String(fd.get("paymentId") ?? "");
  if (!paymentId) return { message: "Something went wrong: no payment was selected.", tone: "error" };

  const original = await getPayment(db, paymentId);
  if (!original) return { message: "That payment no longer exists.", tone: "error" };
  if (original.status !== "failed") {
    return { message: "Only failed payments can be retried.", tone: "info" };
  }

  const rootId = original.retry_of ?? original.id;
  const latest = await db
    .prepare(
      `SELECT * FROM payments
       WHERE COALESCE(retry_of, id) = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(rootId)
    .first<typeof original>();
  if (!latest || latest.id !== original.id || latest.status !== "failed") {
    return { message: "A newer attempt already exists. Refresh the page first.", tone: "info" };
  }
  const priorRetries = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE retry_of = ?")
    .bind(rootId)
    .first<{ n: number }>();
  const attempt = (priorRetries?.n ?? 0) + 1;

  const settings = await getSettings(db);
  if (attempt > settings.default_retry_max) {
    return { message: `Already retried ${settings.default_retry_max} times, which is the limit.`, tone: "info" };
  }

  const idempotencyKey = retryKey(rootId, attempt);
  const reference = uniqueReferenceFromBase(original.reference ?? "ExcelPayment", idempotencyKey);
  const intent = await createOrGetPaymentIntent(db, {
    borrowerId: original.borrower_id,
    scheduleId: original.schedule_id,
    kind: "retry",
    amountMinor: original.amount_minor,
    currency: original.currency,
    reference,
    idempotencyKey,
    createdBy: user.id,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  const result = await collectOrReportUnknown(() =>
    collectPaymentCoordinated(env, {
      borrowerId: original.borrower_id,
      amountMinor: original.amount_minor,
      currency: original.currency,
      reference,
      idempotencyKey,
      // A retry must land in the SAME account as the attempt it replaces. Falling
      // back to the default here would quietly pay a different account than the
      // one the failed payment was for, which is the one mistake in this feature
      // that would move real money to the wrong place.
      consentId: original.consent_id,
      scheduleId: original.schedule_id,
      intentId: intent.id,
      retryOf: rootId,
      actorStaffId: user.id,
    }),
  );

  revalidatePath(`/borrowers/${original.borrower_id}`);
  revalidatePath("/payments");
  return result;
}
