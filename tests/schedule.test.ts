import { describe, it, expect } from "vitest";
import {
  addInterval,
  nextRunDate,
  isEnded,
  amountForRun,
  type ScheduleSpec,
} from "@/lib/schedule";

const base: ScheduleSpec = {
  amountMinor: 10000, // £100.00
  frequency: "weekly",
  startDate: "2026-01-01",
  endMode: "count",
  endCount: 4,
};

// Scenario eval #8: schedule math correct across frequencies and end modes.
describe("addInterval", () => {
  it("weekly adds 7 days", () => {
    expect(addInterval("2026-01-01", base)).toBe("2026-01-08");
  });
  it("fortnightly adds 14 days", () => {
    expect(addInterval("2026-01-01", { ...base, frequency: "fortnightly" })).toBe("2026-01-15");
  });
  it("monthly adds one calendar month, clamped to the month's last day", () => {
    // This used to assert "2026-03-03", which is what JavaScript's setUTCMonth
    // does with 31 January and is not one calendar month by any reading: the
    // borrower's February collection never happened, and every later one moved
    // to the 3rd. Month-end loans are ordinary, so the clamp is the real rule.
    expect(addInterval("2026-01-31", { ...base, frequency: "monthly" })).toBe("2026-02-28");
    expect(addInterval("2026-03-31", { ...base, frequency: "monthly" })).toBe("2026-04-30");
    expect(addInterval("2026-01-15", { ...base, frequency: "monthly" })).toBe("2026-02-15");
    // A leap February still gets its 29th.
    expect(addInterval("2028-01-31", { ...base, frequency: "monthly" })).toBe("2028-02-29");
  });
  it("custom adds intervalDays", () => {
    expect(addInterval("2026-01-01", { ...base, frequency: "custom", intervalDays: 10 })).toBe(
      "2026-01-11",
    );
  });
  it("custom without intervalDays throws", () => {
    expect(() => addInterval("2026-01-01", { ...base, frequency: "custom" })).toThrow();
  });
});

describe("nextRunDate", () => {
  it("returns first run strictly after a given date", () => {
    expect(nextRunDate(base, { afterDate: "2026-01-01", paymentsMade: 0, collectedMinor: 0 })).toBe(
      "2026-01-08",
    );
  });
  it("returns startDate's next occurrence when afterDate precedes start", () => {
    expect(
      nextRunDate(base, { afterDate: "2025-12-01", paymentsMade: 0, collectedMinor: 0 }),
    ).toBe("2026-01-01");
  });
  it("returns null once the payment count is reached", () => {
    expect(
      nextRunDate(base, { afterDate: "2026-01-08", paymentsMade: 4, collectedMinor: 40000 }),
    ).toBeNull();
  });
});

describe("isEnded", () => {
  it("date mode ends after endDate", () => {
    const s: ScheduleSpec = { ...base, endMode: "date", endDate: "2026-02-01", endCount: null };
    expect(isEnded(s, { paymentsMade: 0, collectedMinor: 0, onDate: "2026-02-02" })).toBe(true);
    expect(isEnded(s, { paymentsMade: 0, collectedMinor: 0, onDate: "2026-01-15" })).toBe(false);
  });
  it("total mode ends when collected reaches total", () => {
    const s: ScheduleSpec = { ...base, endMode: "total", endTotalMinor: 40000, endCount: null };
    expect(isEnded(s, { paymentsMade: 4, collectedMinor: 40000, onDate: "2026-03-01" })).toBe(true);
    expect(isEnded(s, { paymentsMade: 3, collectedMinor: 30000, onDate: "2026-03-01" })).toBe(false);
  });
});

describe("amountForRun (total end mode collects a smaller final remainder)", () => {
  it("caps the final payment to the remaining balance", () => {
    const s: ScheduleSpec = { ...base, amountMinor: 30000, endMode: "total", endTotalMinor: 100000 };
    expect(amountForRun(s, 90000)).toBe(10000); // only £100 left of £1000
    expect(amountForRun(s, 0)).toBe(30000);
    expect(amountForRun(s, 100000)).toBe(0);
  });
});
