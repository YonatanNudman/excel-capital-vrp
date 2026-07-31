import type { Consent, Recipient } from "@/lib/types";

export interface Readiness {
  ready: boolean;
  missing: string[];
}

/**
 * Can this borrower actually complete bank authorisation?
 *
 * Plaid needs the destination account AND both consent caps before it will
 * create a VRP consent. Without this check, staff could save an incomplete
 * borrower, send the link, and the borrower would be the one to discover the
 * problem, seeing only "Setup is temporarily unavailable". That happened during
 * testing with a borrower that had no bank details and no limits.
 *
 * Every message is written for the operator who has to fix it, so it names the
 * thing on screen rather than the database column.
 */
export function setupReadiness(
  recipient: Recipient | null | undefined,
  consent: Consent | null | undefined,
): Readiness {
  const missing: string[] = [];

  if (!recipient) {
    missing.push("Add the bank account that repayments should be sent to.");
  } else {
    if (!recipient.account_number?.trim()) {
      missing.push("Add the account number for where repayments are sent.");
    }
    if (!recipient.sort_code?.trim()) {
      missing.push("Add the sort code for where repayments are sent.");
    }
  }

  if (!consent) {
    missing.push(
      "Set the payment limits: the most that can be taken in one payment, and the most per month.",
    );
    return { ready: false, missing };
  }

  // A cap of zero is not a limit, it is an unfilled field.
  if (!consent.max_payment_amount_minor || consent.max_payment_amount_minor <= 0) {
    missing.push("Set the most that can be taken in a single payment.");
  }
  if (!consent.periodic_max_amount_minor || consent.periodic_max_amount_minor <= 0) {
    missing.push("Set the most that can be taken over a whole period, such as per month.");
  }
  if (!consent.period?.trim()) {
    missing.push("Choose the period the limit applies to, such as per month.");
  }

  return { ready: missing.length === 0, missing };
}
