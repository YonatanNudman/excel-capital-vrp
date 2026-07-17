"use server";

import { revalidatePath } from "next/cache";
import { getDb, getEnv } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { getPlaidClient } from "@/lib/plaid";
import { collectPayment, type CollectOutcome } from "@/lib/engine/collect";
import { getActiveSchedule } from "@/lib/repo/schedules";
import { getSettings } from "@/lib/repo/settings";
import { getBorrower } from "@/lib/repo/borrowers";
import { collectionProgress, getPayment } from "@/lib/repo/payments";
import { manualKey, retryKey } from "@/lib/idempotency";
import { buildReference } from "@/lib/reference";
import { newId } from "@/lib/ids";
import { toMinorUnits } from "@/lib/money";

function outcomeMessage(o: CollectOutcome): string {
  switch (o.kind) {
    case "collected":
      return `Submitted (${o.plaidStatus}).`;
    case "duplicate":
      return "Already submitted (idempotent — no duplicate created).";
    case "skipped":
      return `Skipped: ${o.reason}.`;
    case "failed":
      return `Failed: ${o.reason}.`;
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

  const overrideAmount = fd.get("amount");
  let amountMinor: number | null = null;
  if (typeof overrideAmount === "string" && overrideAmount.trim()) {
    amountMinor = toMinorUnits(Number(overrideAmount));
  } else {
    const sched = await getActiveSchedule(db, borrowerId);
    amountMinor = sched?.amount_minor ?? null;
  }
  if (!amountMinor || amountMinor <= 0) {
    return { message: "No amount set (add a schedule or enter an amount)." };
  }

  const settings = await getSettings(db);
  const { paymentsMade } = await collectionProgress(db, borrowerId);
  const reference = buildReference(settings.default_reference_format, {
    borrowerToken: await borrowerToken(db, borrowerId),
    seq: paymentsMade + 1,
  });

  const outcome = await collectPayment(db, getPlaidClient(env), env.APP_ENCRYPTION_KEY, {
    borrowerId,
    amountMinor,
    reference,
    idempotencyKey: manualKey(borrowerId, newId()),
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
  const paymentId = String(fd.get("paymentId") ?? "");
  if (!paymentId) return { message: "paymentId required" };

  const original = await getPayment(db, paymentId);
  if (!original) return { message: "Payment not found." };
  if (original.status !== "failed") {
    return { message: "Only failed payments can be retried." };
  }

  const rootId = original.retry_of ?? original.id;
  const priorRetries = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE retry_of = ?")
    .bind(rootId)
    .first<{ n: number }>();
  const attempt = (priorRetries?.n ?? 0) + 1;

  const settings = await getSettings(db);
  if (attempt > settings.default_retry_max) {
    return { message: `Retry limit (${settings.default_retry_max}) reached.` };
  }

  const outcome = await collectPayment(db, getPlaidClient(env), env.APP_ENCRYPTION_KEY, {
    borrowerId: original.borrower_id,
    amountMinor: original.amount_minor,
    currency: original.currency,
    reference: original.reference ?? "",
    idempotencyKey: retryKey(rootId, attempt),
    retryOf: rootId,
    actorStaffId: user.id,
  });

  revalidatePath(`/borrowers/${original.borrower_id}`);
  revalidatePath("/payments");
  return { message: outcomeMessage(outcome) };
}
