import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createBorrower } from "@/lib/repo/borrowers";
import { getActiveSchedule, upsertSchedule } from "@/lib/repo/schedules";

let n = 0;
const borrower = () =>
  createBorrower(env.DB, { legalName: `Sched ${n++} Ltd`, createdBy: null });

const spec = {
  amountMinor: 10_00,
  frequency: "weekly" as const,
  startDate: "2026-09-01",
  endMode: "count" as const,
  endCount: 4,
};

/**
 * The nightly sweep collects from EVERY row where active = 1, and two active
 * schedules for one borrower would produce two collections on the same day. The
 * double-collection guard cannot catch it either: the idempotency key includes
 * the schedule id, so two schedules make two different keys and both are
 * accepted as legitimate.
 */
describe("a borrower can only have one active schedule", () => {
  it("replaces rather than accumulates when the schedule is edited", async () => {
    const b = await borrower();
    await upsertSchedule(env.DB, b.id, spec);
    await upsertSchedule(env.DB, b.id, { ...spec, amountMinor: 20_00 });

    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM repayment_schedules WHERE borrower_id = ? AND active = 1",
    )
      .bind(b.id)
      .first<{ n: number }>();
    expect(active?.n).toBe(1);
    expect((await getActiveSchedule(env.DB, b.id))?.amount_minor).toBe(20_00);
  });

  it("keeps the superseded schedule, so history survives", async () => {
    const b = await borrower();
    await upsertSchedule(env.DB, b.id, spec);
    await upsertSchedule(env.DB, b.id, { ...spec, amountMinor: 30_00 });
    const all = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM repayment_schedules WHERE borrower_id = ?",
    )
      .bind(b.id)
      .first<{ n: number }>();
    expect(all?.n).toBe(2);
  });

  it("the DATABASE refuses a second active row, not just the code", async () => {
    // The invariant must not depend on one function remembering to deactivate
    // the old row first. Any future insert that forgets is rejected here.
    const b = await borrower();
    await upsertSchedule(env.DB, b.id, spec);
    await expect(
      env.DB.prepare(
        `INSERT INTO repayment_schedules
           (id, borrower_id, amount_minor, currency, frequency, start_date, end_mode, end_count, next_run_date, active)
         VALUES ('sneaky-second', ?, 5000, 'GBP', 'weekly', '2026-09-01', 'count', 4, '2026-09-01', 1)`,
      )
        .bind(b.id)
        .run(),
    ).rejects.toThrow();
  });
});
