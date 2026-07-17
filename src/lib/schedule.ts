/**
 * Repayment schedule math. Pure and I/O-free.
 *
 * Dates are handled as YYYY-MM-DD strings in UTC to avoid timezone drift.
 * Supports weekly / fortnightly / monthly / custom(interval_days), and three
 * end modes: fixed date, number of payments, or total collected amount.
 */

export type Frequency = "weekly" | "fortnightly" | "monthly" | "custom";
export type EndMode = "date" | "count" | "total";

export interface ScheduleSpec {
  amountMinor: number;
  frequency: Frequency;
  intervalDays?: number | null; // required when frequency === "custom"
  startDate: string; // YYYY-MM-DD
  endMode: EndMode;
  endDate?: string | null;
  endCount?: number | null;
  endTotalMinor?: number | null;
}

function parseUTC(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add the schedule's interval once to a given date. */
export function addInterval(date: string, spec: ScheduleSpec): string {
  const d = parseUTC(date);
  switch (spec.frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "fortnightly":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "custom": {
      const days = spec.intervalDays;
      if (!days || days < 1) throw new Error("custom frequency requires intervalDays >= 1");
      d.setUTCDate(d.getUTCDate() + days);
      break;
    }
  }
  return formatUTC(d);
}

/**
 * Whether the schedule has reached its end given how many payments have already
 * *succeeded* and how much has already been collected (minor units), and the
 * date of the run being considered.
 */
export function isEnded(
  spec: ScheduleSpec,
  opts: { paymentsMade: number; collectedMinor: number; onDate: string },
): boolean {
  switch (spec.endMode) {
    case "date":
      return !!spec.endDate && parseUTC(opts.onDate) > parseUTC(spec.endDate);
    case "count":
      return !!spec.endCount && opts.paymentsMade >= spec.endCount;
    case "total":
      return !!spec.endTotalMinor && opts.collectedMinor >= spec.endTotalMinor;
  }
}

/**
 * Compute the next run date strictly after `afterDate`, or null if the schedule
 * has ended. Walks forward from startDate so it is deterministic regardless of
 * when it is called.
 */
export function nextRunDate(
  spec: ScheduleSpec,
  opts: { afterDate: string; paymentsMade: number; collectedMinor: number },
): string | null {
  if (isEnded(spec, { ...opts, onDate: opts.afterDate })) return null;

  let candidate = spec.startDate;
  const after = parseUTC(opts.afterDate);
  // Advance to the first date strictly after `afterDate`.
  let guard = 0;
  while (parseUTC(candidate) <= after) {
    candidate = addInterval(candidate, spec);
    if (++guard > 10_000) throw new Error("nextRunDate exceeded iteration guard");
  }
  if (isEnded(spec, { ...opts, onDate: candidate })) return null;
  return candidate;
}

/** For 'total' end mode: the amount to collect on the final payment may be a
 *  smaller remainder. Returns the amount (minor units) to collect on this run. */
export function amountForRun(spec: ScheduleSpec, collectedMinor: number): number {
  if (spec.endMode === "total" && spec.endTotalMinor != null) {
    const remaining = spec.endTotalMinor - collectedMinor;
    return Math.max(0, Math.min(spec.amountMinor, remaining));
  }
  return spec.amountMinor;
}
