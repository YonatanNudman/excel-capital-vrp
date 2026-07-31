import { toMinorUnits } from "@/lib/money";

const PERIODS = ["DAY", "WEEK", "MONTH", "YEAR"] as const;

export interface BankAndLimitsRaw {
  recipientName?: string;
  accountNumber?: string;
  sortCode?: string;
  maxPaymentAmount?: string;
  periodicMaxAmount?: string;
  consentPeriod?: string;
  consentValidTo?: string;
}

export interface BankAndLimits {
  recipientName: string;
  accountNumber: string;
  sortCode: string;
  maxPaymentAmountMinor: number;
  periodicMaxAmountMinor: number;
  period: string;
  validTo: string | null;
}

export interface ParseResult {
  errors: string[];
  value?: BankAndLimits;
}

/** Positive money amount in major units, or null if unusable. */
function parseAmount(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toMinorUnits(n);
}

/**
 * Validate and normalise the bank destination and VRP limits.
 *
 * Everything Plaid insists on is required here, so an incomplete borrower can
 * never reach the point where the BORROWER discovers the problem. Amounts come
 * back in minor units; the sort code comes back as six bare digits, since Plaid
 * rejects the dashed form people naturally type.
 */
export function parseBankAndLimits(raw: BankAndLimitsRaw): ParseResult {
  const errors: string[] = [];

  const recipientName = (raw.recipientName ?? "").trim();
  if (!recipientName) {
    errors.push("Enter the name on the account that repayments are sent to.");
  }

  const accountDigits = (raw.accountNumber ?? "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(accountDigits)) {
    errors.push("The account number must be 8 digits.");
  }

  const sortDigits = (raw.sortCode ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(sortDigits)) {
    errors.push("The sort code must be 6 digits, for example 12-34-56.");
  }

  const maxPaymentAmountMinor = parseAmount(raw.maxPaymentAmount);
  if (maxPaymentAmountMinor === null) {
    errors.push("Enter the most that can be taken in a single payment.");
  }

  const periodicMaxAmountMinor = parseAmount(raw.periodicMaxAmount);
  if (periodicMaxAmountMinor === null) {
    errors.push("Enter the most that can be taken over a whole period.");
  }

  const period = (raw.consentPeriod ?? "").trim().toUpperCase();
  if (!PERIODS.includes(period as (typeof PERIODS)[number])) {
    errors.push("Choose the period the limit applies to, such as MONTH.");
  }

  // An incoherent pair would authorise a mandate under which the very first
  // payment is impossible, so catch it here rather than at collection time.
  if (
    maxPaymentAmountMinor !== null &&
    periodicMaxAmountMinor !== null &&
    periodicMaxAmountMinor < maxPaymentAmountMinor
  ) {
    errors.push(
      "The limit for the whole period must be at least as much as the single payment limit.",
    );
  }

  if (errors.length > 0) return { errors };

  return {
    errors: [],
    value: {
      recipientName,
      accountNumber: accountDigits,
      sortCode: sortDigits,
      maxPaymentAmountMinor: maxPaymentAmountMinor!,
      periodicMaxAmountMinor: periodicMaxAmountMinor!,
      period,
      validTo: (raw.consentValidTo ?? "").trim() || null,
    },
  };
}
