import type { Payment, RepaymentSchedule } from "@/lib/types";
import { formatMinor } from "@/lib/money";

/**
 * What a payment was for, in the operator's words.
 *
 * Derived from the payment row rather than joining payment_intents, so every
 * historical row gets a label. Without this a £75 late fee and a £500 scheduled
 * collection are indistinguishable in a list.
 */
export type PaymentKind = "scheduled" | "one-off" | "retry";

export function paymentKind(payment: Payment): PaymentKind {
  if (payment.retry_of) return "retry";
  // The DUE DATE is the signal, not the schedule id. A manual collection can
  // carry a schedule id without being a scheduled run, and real rows exist with
  // a due date whose schedule link is missing (the schedule was replaced, or the
  // row predates that column being populated). Those are still scheduled
  // collections and mislabelling them as one-offs is worse than the reverse.
  if (payment.scheduled_for) return "scheduled";
  return "one-off";
}

export interface LoanProgress {
  collectedMinor: number;
  paymentsMade: number;
  /** Null when the schedule ends on a date, where the total is unknowable. */
  targetMinor: number | null;
  remainingMinor: number | null;
  paymentsLeft: number | null;
  percent: number | null;
}

/**
 * How far through the loan this borrower is.
 *
 * The data for this already existed (a cap in end_total_minor, a running total
 * from collectionProgress) but appeared on no screen, which is why the client
 * had to ask whether the total actually stops collections.
 *
 * A date-based schedule genuinely has no total, so the target is null rather
 * than a guess.
 */
export function loanProgress(input: {
  schedule: RepaymentSchedule | null | undefined;
  collectedMinor: number;
  paymentsMade: number;
}): LoanProgress {
  const { schedule, collectedMinor, paymentsMade } = input;
  const base = { collectedMinor, paymentsMade };

  if (!schedule) {
    return { ...base, targetMinor: null, remainingMinor: null, paymentsLeft: null, percent: null };
  }

  let targetMinor: number | null = null;
  if (schedule.end_mode === "total" && schedule.end_total_minor != null) {
    targetMinor = schedule.end_total_minor;
  } else if (schedule.end_mode === "count" && schedule.end_count != null) {
    targetMinor = schedule.end_count * schedule.amount_minor;
  }

  if (targetMinor == null || targetMinor <= 0) {
    return { ...base, targetMinor: null, remainingMinor: null, paymentsLeft: null, percent: null };
  }

  const remainingMinor = Math.max(0, targetMinor - collectedMinor);
  const paymentsLeft =
    schedule.amount_minor > 0 ? Math.ceil(remainingMinor / schedule.amount_minor) : null;

  return {
    ...base,
    targetMinor,
    remainingMinor,
    paymentsLeft,
    percent: Math.min(100, Math.round((collectedMinor / targetMinor) * 100)),
  };
}

/** Roughly how many collections land in a month, per frequency. */
const PER_MONTH: Record<string, number> = {
  daily: 30,
  weekly: 5,
  fortnightly: 3,
  monthly: 2,
  custom: 5,
};

/** Round up to a tidy figure so a suggestion never looks computed to the penny. */
function roundUpTo(minor: number, stepMinor: number): number {
  return Math.ceil(minor / stepMinor) * stepMinor;
}

/**
 * Suggested consent ceilings for a given repayment amount.
 *
 * Exists to prevent the trap the client walked into: setting the single-payment
 * ceiling equal to the repayment, which makes a late fee impossible because the
 * borrower's bank refuses anything above what they agreed.
 *
 * The explanation is returned alongside so the figure carries its own arithmetic
 * rather than appearing from nowhere.
 */
export function suggestCeilings(
  repaymentMinor: number,
  frequency: string,
): { singleMinor: number | null; periodicMinor: number | null; explanation: string } {
  if (!Number.isFinite(repaymentMinor) || repaymentMinor <= 0) {
    return {
      singleMinor: null,
      periodicMinor: null,
      explanation: "Enter the repayment amount and we will suggest sensible ceilings.",
    };
  }

  // 20% headroom, rounded up to the nearest £10.
  const singleMinor = roundUpTo(Math.round(repaymentMinor * 1.2), 1_000);
  const perMonth = PER_MONTH[frequency] ?? 5;
  const periodicMinor = singleMinor * perMonth;

  return {
    singleMinor,
    periodicMinor,
    explanation:
      `${formatMinor(singleMinor, "GBP")} is the repayment plus 20%, leaving room for a late fee. ` +
      `About ${perMonth} ${frequency} collections land in a month, so ` +
      `${formatMinor(periodicMinor, "GBP")} covers the period.`,
  };
}
