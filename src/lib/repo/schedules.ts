import type { EndMode, Frequency, RepaymentSchedule } from "@/lib/types";
import { newId } from "@/lib/ids";
import { nextRunDate, type ScheduleSpec } from "@/lib/schedule";

export interface ScheduleInput {
  amountMinor: number;
  currency?: string;
  frequency: Frequency;
  intervalDays?: number | null;
  startDate: string;
  endMode: EndMode;
  endDate?: string | null;
  endCount?: number | null;
  endTotalMinor?: number | null;
}

export function toSpec(s: RepaymentSchedule | ScheduleInput): ScheduleSpec {
  if ("amount_minor" in s) {
    return {
      amountMinor: s.amount_minor,
      frequency: s.frequency,
      intervalDays: s.interval_days,
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
  const spec = toSpec(input);
  const firstRun = nextRunDate(spec, {
    afterDate: yesterday(input.startDate),
    paymentsMade: 0,
    collectedMinor: 0,
  });

  await db
    .prepare("UPDATE repayment_schedules SET active = 0 WHERE borrower_id = ? AND active = 1")
    .bind(borrowerId)
    .run();

  const id = newId();
  await db
    .prepare(
      `INSERT INTO repayment_schedules
        (id, borrower_id, amount_minor, currency, frequency, interval_days,
         start_date, end_mode, end_date, end_count, end_total_minor, next_run_date, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      id,
      borrowerId,
      input.amountMinor,
      input.currency ?? "GBP",
      input.frequency,
      input.intervalDays ?? null,
      input.startDate,
      input.endMode,
      input.endDate ?? null,
      input.endCount ?? null,
      input.endTotalMinor ?? null,
      firstRun,
    )
    .run();

  const created = await db
    .prepare("SELECT * FROM repayment_schedules WHERE id = ?")
    .bind(id)
    .first<RepaymentSchedule>();
  if (!created) throw new Error("failed to create schedule");
  return created;
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
