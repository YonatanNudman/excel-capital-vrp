import { describe, it, expect } from "vitest";
import { paymentKind, loanProgress, suggestCeilings } from "@/lib/loan-progress";
import type { Payment, RepaymentSchedule } from "@/lib/types";

const payment = (over: Partial<Payment> = {}): Payment =>
  ({
    id: "p1",
    borrower_id: "b1",
    schedule_id: null,
    scheduled_for: null,
    retry_of: null,
    amount_minor: 50_000,
    currency: "GBP",
    status: "settled",
    ...over,
  }) as Payment;

const schedule = (over: Partial<RepaymentSchedule> = {}): RepaymentSchedule =>
  ({
    id: "s1",
    borrower_id: "b1",
    amount_minor: 50_000,
    currency: "GBP",
    frequency: "weekly",
    interval_days: null,
    days_of_week: null,
    start_date: "2026-08-03",
    end_mode: "count",
    end_date: null,
    end_count: 12,
    end_total_minor: null,
    next_run_date: "2026-08-10",
    active: 1,
    created_at: "",
    ...over,
  }) as RepaymentSchedule;

describe("paymentKind: what was this payment for?", () => {
  /**
   * A late fee and a scheduled collection look identical on screen without this.
   * Derived from the payment row itself rather than joining payment_intents, so
   * it works for every historical row.
   */
  it("calls a scheduled collection scheduled", () => {
    expect(paymentKind(payment({ schedule_id: "s1", scheduled_for: "2026-08-10" }))).toBe(
      "scheduled",
    );
  });

  it("calls anything with no schedule a one-off", () => {
    expect(paymentKind(payment())).toBe("one-off");
  });

  it("calls a retry a retry, even when it came from a schedule", () => {
    expect(
      paymentKind(payment({ schedule_id: "s1", scheduled_for: "2026-08-10", retry_of: "p0" })),
    ).toBe("retry");
  });

  it("treats a schedule id with no due date as a one-off", () => {
    // A manual collection can carry a schedule id without being a scheduled run.
    expect(paymentKind(payment({ schedule_id: "s1", scheduled_for: null }))).toBe("one-off");
  });

  it("still calls it scheduled when the due date survives but the schedule link does not", () => {
    // Found in real staging data: a collection for a due date whose schedule row
    // was since replaced. Calling that a one-off would misreport history.
    expect(paymentKind(payment({ schedule_id: null, scheduled_for: "2026-07-17" }))).toBe(
      "scheduled",
    );
  });
});

describe("loanProgress", () => {
  it("reports collected, remaining and payments left for a total-based schedule", () => {
    const p = loanProgress({
      schedule: schedule({ end_mode: "total", end_total_minor: 600_000, end_count: null }),
      collectedMinor: 150_000,
      paymentsMade: 3,
    });
    expect(p.collectedMinor).toBe(150_000);
    expect(p.targetMinor).toBe(600_000);
    expect(p.remainingMinor).toBe(450_000);
    expect(p.paymentsLeft).toBe(9); // 450000 / 50000
    expect(p.percent).toBe(25);
  });

  it("uses count times amount as the target for a count-based schedule", () => {
    const p = loanProgress({
      schedule: schedule({ end_mode: "count", end_count: 12 }),
      collectedMinor: 100_000,
      paymentsMade: 2,
    });
    expect(p.targetMinor).toBe(600_000);
    expect(p.paymentsLeft).toBe(10);
    expect(p.percent).toBe(17); // rounded
  });

  it("never reports negative remaining when more was collected than planned", () => {
    const p = loanProgress({
      schedule: schedule({ end_mode: "total", end_total_minor: 100_000, end_count: null }),
      collectedMinor: 130_000,
      paymentsMade: 3,
    });
    expect(p.remainingMinor).toBe(0);
    expect(p.paymentsLeft).toBe(0);
    expect(p.percent).toBe(100);
  });

  it("has no target for a date-based schedule, since the total is unknown", () => {
    const p = loanProgress({
      schedule: schedule({ end_mode: "date", end_date: "2026-12-31", end_count: null }),
      collectedMinor: 100_000,
      paymentsMade: 2,
    });
    expect(p.targetMinor).toBeNull();
    expect(p.remainingMinor).toBeNull();
    expect(p.percent).toBeNull();
    expect(p.collectedMinor).toBe(100_000);
  });

  it("handles no schedule at all", () => {
    const p = loanProgress({ schedule: null, collectedMinor: 25_000, paymentsMade: 1 });
    expect(p.collectedMinor).toBe(25_000);
    expect(p.targetMinor).toBeNull();
    expect(p.paymentsLeft).toBeNull();
  });

  it("is honest at zero rather than dividing by nothing", () => {
    const p = loanProgress({
      schedule: schedule({ end_mode: "total", end_total_minor: 0, end_count: null }),
      collectedMinor: 0,
      paymentsMade: 0,
    });
    expect(p.percent).toBeNull();
  });
});

describe("suggestCeilings", () => {
  /**
   * The £500 repayment with a £500 ceiling trap: a late fee becomes impossible.
   * Suggesting headroom prevents it at the point of entry rather than warning
   * about it afterwards.
   */
  it("suggests 20% headroom on a single payment, rounded up to a round number", () => {
    expect(suggestCeilings(50_000, "weekly").singleMinor).toBe(60_000); // £500 -> £600
    expect(suggestCeilings(12_345, "weekly").singleMinor).toBe(15_000); // £123.45 -> £150
  });

  it("scales the period ceiling by how often collections happen in a month", () => {
    // Weekly is about 5 collections in a month at the ceiling amount.
    expect(suggestCeilings(50_000, "weekly").periodicMinor).toBe(60_000 * 5);
    expect(suggestCeilings(50_000, "fortnightly").periodicMinor).toBe(60_000 * 3);
    expect(suggestCeilings(50_000, "monthly").periodicMinor).toBe(60_000 * 2);
  });

  it("explains its own arithmetic so the number is not magic", () => {
    const s = suggestCeilings(50_000, "weekly");
    expect(s.explanation).toMatch(/£600/);
    expect(s.explanation).toMatch(/5/);
  });

  it("suggests nothing for a missing or nonsensical amount", () => {
    expect(suggestCeilings(0, "weekly").singleMinor).toBeNull();
    expect(suggestCeilings(-100, "weekly").singleMinor).toBeNull();
  });
});
