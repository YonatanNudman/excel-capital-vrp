import type { EndMode, Frequency, RepaymentSchedule } from "@/lib/types";
import { newId } from "@/lib/ids";
import {
  nextRunDate,
  type ScheduleSpec,
  type Frequency as ScheduleFrequency,
} from "@/lib/schedule";

export interface ScheduleInput {
  amountMinor: number;
  currency?: string;
  /** Domain frequency, which may be "daily". Encoded for storage on write. */
  frequency: ScheduleFrequency;
  intervalDays?: number | null;
  daysOfWeek?: number[] | null;
  startDate: string;
  endMode: EndMode;
  endDate?: string | null;
  endCount?: number | null;
  endTotalMinor?: number | null;
}

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Storage encoding for "daily".
 *
 * The frequency CHECK constraint predates the daily option and cannot be widened
 * without rebuilding a table the payment ledger references (see
 * migrations/0004). So a daily schedule is stored as 'custom' with
 * interval_days = 1 and an ALWAYS-PRESENT days_of_week list (all seven when the
 * operator ticks nothing). That list is what makes the row unambiguously daily
 * on the way back out.
 */
function encodeFrequency(input: ScheduleInput): {
  frequency: Frequency; // storable value only
  intervalDays: number | null;
  daysOfWeek: number[] | null;
} {
  if (input.frequency !== "daily") {
    return {
      frequency: input.frequency as Frequency,
      intervalDays: input.intervalDays ?? null,
      daysOfWeek: null,
    };
  }
  return {
    frequency: "custom",
    intervalDays: 1,
    daysOfWeek: input.daysOfWeek && input.daysOfWeek.length > 0 ? input.daysOfWeek : ALL_DAYS,
  };
}

/** True when a stored row is one of the daily schedules encoded above. */
export function isStoredDaily(s: {
  frequency: Frequency;
  interval_days: number | null;
  days_of_week: string | null;
}): boolean {
  return s.frequency === "custom" && s.interval_days === 1 && !!s.days_of_week;
}

/** "1,2,3" as stored becomes [1,2,3]; blank or null becomes null (every day). */
export function parseDaysOfWeek(stored: string | null | undefined): number[] | null {
  if (!stored) return null;
  const days = stored
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : null;
}

/** Stored canonically: sorted, de-duplicated, comma separated. */
export function formatDaysOfWeek(days: number[] | null | undefined): string | null {
  if (!days || days.length === 0) return null;
  return [...new Set(days)].sort((a, b) => a - b).join(",");
}

export function toSpec(s: RepaymentSchedule | ScheduleInput): ScheduleSpec {
  if ("amount_minor" in s) {
    const daily = isStoredDaily(s);
    return {
      amountMinor: s.amount_minor,
      frequency: daily ? "daily" : s.frequency,
      intervalDays: daily ? null : s.interval_days,
      daysOfWeek: parseDaysOfWeek(s.days_of_week),
      startDate: s.start_date,
      endMode: s.end_mode,
      endDate: s.end_date,
      endCount: s.end_count,
      endTotalMinor: s.end_total_minor,
    };
  }
  return {
    amountMinor: s.amountMinor,
    frequency: s.frequency,
    intervalDays: s.intervalDays ?? null,
    daysOfWeek: s.daysOfWeek ?? null,
    startDate: s.startDate,
    endMode: s.endMode,
    endDate: s.endDate ?? null,
    endCount: s.endCount ?? null,
    endTotalMinor: s.endTotalMinor ?? null,
  };
}

export async function getActiveSchedule(
  db: D1Database,
  borrowerId: string,
): Promise<RepaymentSchedule | null> {
  return db
    .prepare(
      "SELECT * FROM repayment_schedules WHERE borrower_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(borrowerId)
    .first<RepaymentSchedule>();
}

/** Deactivate any existing schedule and insert a new active one. */
export async function upsertSchedule(
  db: D1Database,
  borrowerId: string,
  input: ScheduleInput,
): Promise<RepaymentSchedule> {
  validateSchedule(input);
  const encoded = encodeFrequency(input);
  const spec = toSpec(input);
  const firstRun = nextRunDate(spec, {
    afterDate: yesterday(input.startDate),
    paymentsMade: 0,
    collectedMinor: 0,
  });

  const id = newId();
  await db.batch([
    db.prepare("UPDATE repayment_schedules SET active = 0 WHERE borrower_id = ? AND active = 1")
      .bind(borrowerId),
    db.prepare(
      `INSERT INTO repayment_schedules
        (id, borrower_id, amount_minor, currency, frequency, interval_days,
         days_of_week, start_date, end_mode, end_date, end_count, end_total_minor,
         next_run_date, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      id,
      borrowerId,
      input.amountMinor,
      input.currency ?? "GBP",
      encoded.frequency,
      encoded.intervalDays,
      formatDaysOfWeek(encoded.daysOfWeek),
      input.startDate,
      input.endMode,
      input.endDate ?? null,
      input.endCount ?? null,
      input.endTotalMinor ?? null,
      firstRun,
    ),
  ]);

  const created = await db
    .prepare("SELECT * FROM repayment_schedules WHERE id = ?")
    .bind(id)
    .first<RepaymentSchedule>();
  if (!created) throw new Error("failed to create schedule");
  return created;
}

function validateSchedule(input: ScheduleInput): void {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("schedule amount must be a positive integer in minor units");
  }
  if (!isDate(input.startDate)) throw new Error("invalid schedule start date");
  if (input.frequency === "custom" &&
      (!Number.isInteger(input.intervalDays) || input.intervalDays! < 1 || input.intervalDays! > 3650)) {
    throw new Error("custom interval must be between 1 and 3650 days");
  }
  if (input.daysOfWeek) {
    for (const d of input.daysOfWeek) {
      if (!Number.isInteger(d) || d < 1 || d > 7) {
        throw new Error("selected days must be between 1 (Monday) and 7 (Sunday)");
      }
    }
  }
  if (input.endMode === "date") {
    if (!input.endDate || !isDate(input.endDate) || input.endDate < input.startDate) {
      throw new Error("schedule end date must be on or after the start date");
    }
  }
  if (input.endMode === "count" &&
      (!Number.isInteger(input.endCount) || input.endCount! < 1 || input.endCount! > 10000)) {
    throw new Error("schedule payment count must be between 1 and 10000");
  }
  if (input.endMode === "total" &&
      (!Number.isSafeInteger(input.endTotalMinor) || input.endTotalMinor! <= 0)) {
    throw new Error("schedule total must be a positive amount");
  }
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export async function setScheduleNextRun(
  db: D1Database,
  id: string,
  nextRun: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE repayment_schedules SET next_run_date = ?, active = ? WHERE id = ?")
    .bind(nextRun, nextRun ? 1 : 0, id)
    .run();
}

/** Schedules whose next_run_date is on or before `onDate` and still active. */
export async function dueSchedules(
  db: D1Database,
  onDate: string,
): Promise<RepaymentSchedule[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM repayment_schedules WHERE active = 1 AND next_run_date IS NOT NULL AND next_run_date <= ?",
    )
    .bind(onDate)
    .all<RepaymentSchedule>();
  return results ?? [];
}

function yesterday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
