import type { EndMode, Frequency, RepaymentSchedule } from "@/lib/types";
import { newId } from "@/lib/ids";
import { collectionProgress } from "@/lib/repo/payments";
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
  /** Mandate to collect against, and so the account paid into. Null = default. */
  consentId?: string | null;
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
      // Weekly and fortnightly are weekday-aware too (see WEEKDAY_AWARE in
      // lib/schedule.ts), and the form tells the operator so in as many words:
      // "For Weekly or Fortnightly: tick the one day you want". Discarding the
      // choice here meant collections landed on whatever weekday the start date
      // happened to be, days away from the day they were promised.
      daysOfWeek:
        (input.frequency === "weekly" || input.frequency === "fortnightly") &&
        input.daysOfWeek &&
        input.daysOfWeek.length > 0
          ? input.daysOfWeek
          : null,
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

/**
 * Deactivate any existing schedule and insert a new active one.
 *
 * Two properties here exist to stop an edit from taking money it should not.
 *
 * FIRST, the new row never becomes due for a date in the past. next_run_date was
 * computed by walking forward from `startDate` alone, and the edit form
 * re-submits the ORIGINAL start date, so saving any change to a running schedule
 * rewound it to the loan's first instalment. The nightly sweep then collected one
 * backdated instalment per night until it caught up with today: for a borrower
 * eight months into a weekly loan, roughly thirty further debits of a loan they
 * had already been paying. `today` is a parameter so a caller replaying a
 * historical timeline (the tests) can say which day it is.
 *
 * SECOND, the loan's progress carries across the edit. Every end condition and
 * the double-collection key were keyed on the schedule ROW id, which changes on
 * every save, so an edit reset paymentsMade and collectedMinor to zero and a
 * finished loan would run its whole term again. lineage_id (migration 0010) is
 * the id of the first schedule in the chain and is what those now key on.
 */
export async function upsertSchedule(
  db: D1Database,
  borrowerId: string,
  input: ScheduleInput,
  opts: { today?: string } = {},
): Promise<RepaymentSchedule> {
  validateSchedule(input);
  const encoded = encodeFrequency(input);
  const spec = toSpec(input);

  const previous = await getActiveSchedule(db, borrowerId);
  // Read against the PREVIOUS row, which is still active at this point, so the
  // lineage query resolves; the new row inherits its lineage below.
  const carried = previous
    ? await collectionProgress(db, borrowerId, previous.id)
    : { paymentsMade: 0, collectedMinor: 0 };

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  // Never earlier than today: a schedule saved now describes what happens from
  // now on. A start date in the past is history, not a collection instruction.
  const afterDate = laterDate(yesterday(input.startDate), yesterday(today));
  const firstRun = nextRunDate(spec, {
    afterDate,
    paymentsMade: carried.paymentsMade,
    collectedMinor: carried.collectedMinor,
  });

  const id = newId();
  const lineageId = previous?.lineage_id ?? previous?.id ?? id;
  await db.batch([
    db.prepare("UPDATE repayment_schedules SET active = 0 WHERE borrower_id = ? AND active = 1")
      .bind(borrowerId),
    db.prepare(
      `INSERT INTO repayment_schedules
        (id, borrower_id, consent_id, amount_minor, currency, frequency, interval_days,
         days_of_week, start_date, end_mode, end_date, end_count, end_total_minor,
         next_run_date, lineage_id, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      id,
      borrowerId,
      // Which account scheduled collections pay into. Null means the borrower's
      // default, which is every schedule that existed before this was a choice.
      input.consentId ?? null,
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
      lineageId,
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

/**
 * Advance (or end) a schedule after an attempt.
 *
 * Guarded on `active = 1` because this sets active back to 1 whenever it is
 * given a date. The nightly sweep reads its list of due schedules once and
 * advances each one afterwards, so an operator saving an edit mid-sweep left the
 * sweep holding a row that had just been superseded: advancing it would have
 * revived a second active schedule for that borrower, which the partial unique
 * index (migration 0008) rejects with an error that then aborted the rest of the
 * night's collections. A superseded row is finished; leave it alone.
 */
export async function setScheduleNextRun(
  db: D1Database,
  id: string,
  nextRun: string | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE repayment_schedules SET next_run_date = ?, active = ? WHERE id = ? AND active = 1",
    )
    .bind(nextRun, nextRun ? 1 : 0, id)
    .run();
}

/**
 * The identity that follows a loan across edits: what progress, end conditions
 * and idempotency keys must key on, never the row id.
 */
export function lineageOf(s: Pick<RepaymentSchedule, "id" | "lineage_id">): string {
  return s.lineage_id ?? s.id;
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

/** The later of two YYYY-MM-DD dates, which sort correctly as strings. */
function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function yesterday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
