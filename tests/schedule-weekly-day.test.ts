import { describe, it, expect } from "vitest";
import { firstAllowedDate, nextRunDate, type ScheduleSpec } from "@/lib/schedule";

// 2026-08-03 is a Monday. Mon 03, Tue 04, Wed 05, Thu 06, Fri 07, Sat 08, Sun 09.
const weekly = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  amountMinor: 50_000,
  frequency: "weekly",
  startDate: "2026-08-03", // Monday
  endMode: "count",
  endCount: 10,
  ...over,
});

const runs = (spec: ScheduleSpec, from: string, count: number): string[] => {
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextRunDate(spec, { afterDate: cursor, paymentsMade: i, collectedMinor: 0 });
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
};

describe("weekly on a chosen day", () => {
  /**
   * The client's complaint: picking "weekly" only let them choose a start date,
   * so the weekday was an accident of that date rather than a choice.
   */
  it("moves the first run to the chosen weekday", () => {
    // Start Monday but collect on Tuesdays.
    const spec = weekly({ daysOfWeek: [2] });
    expect(runs(spec, "2026-08-02", 3)).toEqual([
      "2026-08-04", // Tue
      "2026-08-11",
      "2026-08-18",
    ]);
  });

  it("keeps the chosen weekday when the start date already matches", () => {
    const spec = weekly({ startDate: "2026-08-05", daysOfWeek: [3] }); // Wed
    expect(runs(spec, "2026-08-04", 2)).toEqual(["2026-08-05", "2026-08-12"]);
  });

  it("never moves the first run earlier than the start date", () => {
    // Start Wednesday, collect on Tuesdays: the first Tuesday is the NEXT week.
    const spec = weekly({ startDate: "2026-08-05", daysOfWeek: [2] });
    expect(runs(spec, "2026-08-04", 2)).toEqual(["2026-08-11", "2026-08-18"]);
  });

  it("behaves as before when no day is chosen", () => {
    const spec = weekly();
    expect(runs(spec, "2026-08-02", 3)).toEqual([
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
    ]);
  });

  it("applies to fortnightly too", () => {
    const spec = weekly({ frequency: "fortnightly", daysOfWeek: [5] }); // Fri
    expect(runs(spec, "2026-08-02", 3)).toEqual([
      "2026-08-07",
      "2026-08-21",
      "2026-09-04",
    ]);
  });

  it("uses the earliest chosen day if several are ticked, since weekly runs once", () => {
    // The UI offers one day for weekly, but the data model allows a set. Pick
    // deterministically rather than depending on array order.
    const spec = weekly({ daysOfWeek: [5, 2, 4] });
    expect(runs(spec, "2026-08-02", 2)).toEqual(["2026-08-04", "2026-08-11"]);
  });

  it("does not shift monthly schedules, where a weekday makes no sense", () => {
    const spec = weekly({ frequency: "monthly", startDate: "2026-08-17", daysOfWeek: [2] });
    expect(runs(spec, "2026-08-16", 2)).toEqual(["2026-08-17", "2026-09-17"]);
  });
});

describe("firstAllowedDate for weekly", () => {
  it("advances to the chosen weekday", () => {
    expect(firstAllowedDate("2026-08-03", weekly({ daysOfWeek: [4] }))).toBe("2026-08-06");
  });

  it("leaves the date alone when no day is chosen", () => {
    expect(firstAllowedDate("2026-08-03", weekly())).toBe("2026-08-03");
  });
});
