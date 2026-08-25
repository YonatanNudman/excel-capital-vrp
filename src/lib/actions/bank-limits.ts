"use server";

import { revalidatePath } from "next/cache";
import { getDb, getEnv } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { writeAudit } from "@/lib/repo/audit";
import { protectString } from "@/lib/crypto";
import { upsertRecipient } from "@/lib/repo/recipients";
import {
  getActiveConsent,
  createPendingConsent,
  updateUnauthorisedConsentLimits,
  setConsentRecipient,
} from "@/lib/repo/consents";
import { parseBankAndLimits } from "@/lib/borrower-setup-input";

/**
 * `values` echoes back what was submitted so a validation error does not wipe
 * the operator's typing. Without it, fixing one field silently clears the rest.
 */
export interface BankLimitsValues {
  recipientName: string;
  accountNumber: string;
  sortCode: string;
  maxPaymentAmount: string;
  periodicMaxAmount: string;
  consentPeriod: string;
}
export type BankLimitsState =
  | { errors?: string[]; saved?: boolean; values?: BankLimitsValues }
  | null;

/**
 * Set or correct the destination bank account and the VRP limits for a borrower
 * that has not authorised yet.
 *
 * This exists because a borrower could previously be created with neither, and
 * there was then no way to fill them in: the only failure surfaced was the
 * borrower seeing "Setup is temporarily unavailable".
 */
export async function updateBankAndLimitsAction(
  _prev: BankLimitsState,
  fd: FormData,
): Promise<BankLimitsState> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();

  const borrowerId = String(fd.get("borrowerId") ?? "");
  if (!borrowerId) return { errors: ["Something went wrong: no borrower was selected."] };

  const values: BankLimitsValues = {
    recipientName: String(fd.get("recipientName") ?? ""),
    accountNumber: String(fd.get("recipientAccount") ?? ""),
    sortCode: String(fd.get("recipientSort") ?? ""),
    maxPaymentAmount: String(fd.get("maxPaymentAmount") ?? ""),
    periodicMaxAmount: String(fd.get("periodicMaxAmount") ?? ""),
    consentPeriod: String(fd.get("consentPeriod") ?? ""),
  };

  const parsed = parseBankAndLimits({
    ...values,
    consentValidTo: String(fd.get("consentValidTo") ?? ""),
  });
  if (parsed.errors.length > 0 || !parsed.value) return { errors: parsed.errors, values };
  const v = parsed.value;

  const consent = await getActiveConsent(db, borrowerId);
  if (consent?.status === "authorized") {
    return {
      errors: [
        "This borrower has already authorised these limits with their bank, so they cannot be changed here. Send a new setup link to agree new limits.",
      ],
      values,
    };
  }

  const recipient = await upsertRecipient(db, borrowerId, {
    name: v.recipientName,
    accountNumber: await protectString(v.accountNumber, env.APP_ENCRYPTION_KEY),
    sortCode: await protectString(v.sortCode, env.APP_ENCRYPTION_KEY),
  });

  if (consent) {
    await updateUnauthorisedConsentLimits(db, consent.id, {
      maxPaymentAmountMinor: v.maxPaymentAmountMinor,
      periodicMaxAmountMinor: v.periodicMaxAmountMinor,
      period: v.period,
      validTo: v.validTo,
    });
    // Bind the mandate to this account. Without it the mandate is an orphan: still
    // collectable, but the payment history could not say where money went.
    if (!consent.recipient_id) await setConsentRecipient(db, consent.id, recipient.id);
  } else {
    await createPendingConsent(db, borrowerId, {
      recipientId: recipient.id,
      currency: "GBP",
      maxPaymentAmountMinor: v.maxPaymentAmountMinor,
      periodicMaxAmountMinor: v.periodicMaxAmountMinor,
      period: v.period,
      periodicAlignment: "CALENDAR",
      validTo: v.validTo,
    });
  }

  await writeAudit(db, {
    actorStaffId: user.id,
    action: "borrower.bank_and_limits.update",
    entityType: "borrower",
    entityId: borrowerId,
  });
  revalidatePath(`/borrowers/${borrowerId}`);
  return { saved: true };
}
