"use server";

import { revalidatePath } from "next/cache";
import { getDb, getEnv } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import type { CollectOutcome } from "@/lib/engine/collect";
import { collectPaymentCoordinated } from "@/lib/durable/coordinated-collect";
import { getActiveSchedule } from "@/lib/repo/schedules";
import { toSpec } from "@/lib/repo/schedules";
import { getSettings } from "@/lib/repo/settings";
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
import { amountForRun } from "@/lib/schedule";

function outcomeMessage(o: CollectOutcome): string {
  switch (o.kind) {
    case "collected":
      return `Submitted (${o.plaidStatus}).`;
    case "duplicate":
      return "Already submitted (idempotent, no duplicate created).";
    case "skipped":
      return `Skipped: ${o.reason}.`;
    case "failed":
      return `Failed: ${o.reason}.`;
    case "unknown":
      return "Payment status is being confirmed. Do not submit it again.";
  }
}

async function borrowerToken(db: D1Database, borrowerId: string): Promise<string> {
  const b = await getBorrower(db, borrowerId);
  return (b?.company_number || b?.legal_name || borrowerId).slice(0, 8).toUpperCase();
}

export type ActionState = { message: string } | null;

/** Manual one-off collection. Amount defaults to the active schedule amount. */
export async function executePaymentNowAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();
  const borrowerId = String(fd.get("borrowerId") ?? "");
  if (!borrowerId) return { message: "borrowerId required" };
  if (String(env.COLLECTIONS_ENABLED) !== "true") {
    return { message: "Collections are disabled by the go-live safety switch." };
  }

  const overrideAmount = fd.get("amount");
  const schedule = await getActiveSchedule(db, borrowerId);
  const today = new Date().toISOString().slice(0, 10);
  const isScheduledRun =
    !(typeof overrideAmount === "string" && overrideAmount.trim()) &&
    Boolean(schedule?.next_run_date && schedule.next_run_date <= today);
  if (
    schedule &&
    !(typeof overrideAmount === "string" && overrideAmount.trim()) &&
    await getSchedulePaymentCreatedOn(db, schedule.id, today)
  ) {
    return { message: "Today's scheduled payment is already submitted. No duplicate was created." };
  }
  let amountMinor: number | null = null;
  if (typeof overrideAmount === "string" && overrideAmount.trim()) {
    amountMinor = toMinorUnits(Number(overrideAmount));
  } else {
    if (schedule && isScheduledRun) {
      const progress = await collectionProgress(db, borrowerId, schedule.id);
      amountMinor = amountForRun(toSpec(schedule), progress.collectedMinor);
    } else {
      amountMinor = schedule?.amount_minor ?? null;
    }
  }
  if (!amountMinor || amountMinor <= 0) {
    return { message: "No amount set (add a schedule or enter an amount)." };
  }

  const settings = await getSettings(db);
  const { paymentsMade } = await collectionProgress(db, borrowerId, schedule?.id);

  const nonce = String(fd.get("nonce") ?? "") || newId();
  const idempotencyKey = isScheduledRun && schedule
    ? scheduledKey(borrowerId, schedule.id, schedule.next_run_date!)
    : manualKey(borrowerId, nonce);
  const reference = buildUniqueReference(settings.default_reference_format, {
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

  const outcome = await collectPaymentCoordinated(env, {
      borrowerId,
      amountMinor,
      reference,
      idempotencyKey,
      scheduleId: isScheduledRun ? schedule?.id : null,
      scheduledFor: isScheduledRun ? schedule?.next_run_date : null,
      intentId: intent.id,
      actorStaffId: user.id,
    });

  revalidatePath(`/borrowers/${borrowerId}`);
  revalidatePath("/payments");
  return { message: outcomeMessage(outcome) };
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
    return { message: "Collections are disabled by the go-live safety switch." };
  }
  const paymentId = String(fd.get("paymentId") ?? "");
  if (!paymentId) return { message: "paymentId required" };

  const original = await getPayment(db, paymentId);
  if (!original) return { message: "Payment not found." };
  if (original.status !== "failed") {
    return { message: "Only failed payments can be retried." };
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
    return { message: "A newer attempt already exists. Refresh before retrying." };
  }
  const priorRetries = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE retry_of = ?")
    .bind(rootId)
    .first<{ n: number }>();
  const attempt = (priorRetries?.n ?? 0) + 1;

  const settings = await getSettings(db);
  if (attempt > settings.default_retry_max) {
    return { message: `Retry limit (${settings.default_retry_max}) reached.` };
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
  const outcome = await collectPaymentCoordinated(env, {
      borrowerId: original.borrower_id,
      amountMinor: original.amount_minor,
      currency: original.currency,
      reference,
      idempotencyKey,
      scheduleId: original.schedule_id,
      intentId: intent.id,
      retryOf: rootId,
      actorStaffId: user.id,
    });

  revalidatePath(`/borrowers/${original.borrower_id}`);
  revalidatePath("/payments");
  return { message: outcomeMessage(outcome) };
}
