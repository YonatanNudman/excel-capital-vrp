/**
 * Repayment schedule math. Pure and I/O-free.
 *
 * Dates are handled as YYYY-MM-DD strings in UTC to avoid timezone drift.
 * Supports daily (optionally restricted to chosen weekdays), weekly,
 * fortnightly, monthly and custom(interval_days), with three end modes: fixed
 * date, number of payments, or total collected amount.
 */

export type Frequency = "daily" | "weekly" | "fortnightly" | "monthly" | "custom";
export type EndMode = "date" | "count" | "total";

export interface ScheduleSpec {
  amountMinor: number;
  frequency: Frequency;
  intervalDays?: number | null; // required when frequency === "custom"
  /**
   * Which weekdays a "daily" schedule may run on, ISO numbering (1 = Monday
   * through 7 = Sunday). Empty or absent means every day. Ignored by the other
   * frequencies. Lets a lender collect only on working days.
   */
  daysOfWeek?: number[] | null;
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

/** ISO weekday: 1 = Monday through 7 = Sunday (JS getUTCDay puts Sunday at 0). */
function isoWeekday(d: Date): number {
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The set of weekdays a daily schedule may run on. An empty or absent selection
 * means every day, which is the sensible reading of "daily" with nothing ticked.
 */
function allowedWeekdays(spec: ScheduleSpec): Set<number> | null {
  const raw = spec.daysOfWeek;
  if (!raw || raw.length === 0) return null;
  for (const d of raw) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      throw new Error(`invalid day of week: ${d} (expected 1 to 7, Monday to Sunday)`);
    }
  }
  return new Set(raw);
}

/**
 * Move forward to the first date on or after `date` that falls on an allowed
 * weekday. Used so a start date on an excluded day does not produce a run.
 */
export function firstAllowedDate(date: string, spec: ScheduleSpec): string {
  const allowed = allowedWeekdays(spec);
  if (spec.frequency !== "daily" || !allowed) return date;
  const d = parseUTC(date);
  for (let i = 0; i < 7; i++) {
    if (allowed.has(isoWeekday(d))) return formatUTC(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Unreachable: a non-empty subset of 1..7 always matches within seven days.
  throw new Error("no allowed day of week found");
}

/** Add the schedule's interval once to a given date. */
export function addInterval(date: string, spec: ScheduleSpec): string {
  const d = parseUTC(date);
  switch (spec.frequency) {
    case "daily": {
      const allowed = allowedWeekdays(spec);
      d.setUTCDate(d.getUTCDate() + 1);
      if (allowed) {
        // At most six further steps, since the set is a non-empty subset of the week.
        for (let i = 0; i < 7 && !allowed.has(isoWeekday(d)); i++) {
          d.setUTCDate(d.getUTCDate() + 1);
        }
      }
      break;
    }
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

  let candidate = firstAllowedDate(spec.startDate, spec);
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
