import type { Consent } from "@/lib/types";
import { formatMinor } from "@/lib/money";

/**
 * Check a one-off amount against what the borrower actually authorised.
 *
 * The bank enforces the same caps, so this is not the security boundary. It
 * exists so an operator who types a late fee that breaches the mandate is told
 * why BEFORE a payment row is created and rejected, rather than seeing an opaque
 * provider failure afterwards.
 *
 * Returns null when the amount is allowed, or a message for the operator.
 */
export function checkAmountAgainstConsent(
  amountMinor: number,
  consent: Consent | null | undefined,
): string | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return "Enter an amount greater than zero.";
  }

  if (!consent || consent.status !== "authorized") {
    return "This borrower has not authorised payments with their bank yet, so nothing can be collected.";
  }

  const cap = consent.max_payment_amount_minor;
  if (cap != null && cap > 0 && amountMinor > cap) {
    return (
      `${formatMinor(amountMinor, consent.currency)} is more than the ` +
      `${formatMinor(cap, consent.currency)} the borrower agreed to for a single payment, ` +
      `so their bank would refuse it. To collect more, send a new setup link and ask them ` +
      `to authorise a higher limit.`
    );
  }

  // The periodic cap is deliberately not checked here: working out what counts
  // towards the current period needs the consent's alignment and the provider's
  // own view of settled payments. The bank enforces it, and the resulting
  // failure is reported on the payment.
  return null;
}
