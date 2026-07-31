import { describe, it, expect } from "vitest";
import { addInterval, nextRunDate, type ScheduleSpec } from "@/lib/schedule";

// 2026-08-03 is a Monday. Reference week:
//   Mon 2026-08-03, Tue 04, Wed 05, Thu 06, Fri 07, Sat 08, Sun 09, Mon 10
const MON = "2026-08-03";
const FRI = "2026-08-07";
const SAT = "2026-08-08";

const daily = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  amountMinor: 25_000,
  frequency: "daily",
  startDate: MON,
  endMode: "count",
  endCount: 100,
  ...over,
});

const runs = (spec: ScheduleSpec, from: string, count: number): string[] => {
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextRunDate(spec, {
      afterDate: cursor,
      paymentsMade: i,
      collectedMinor: 0,
    });
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
};

describe("daily frequency: weekday selection", () => {
  it("runs Monday to Friday and skips the weekend", () => {
    const spec = daily({ daysOfWeek: [1, 2, 3, 4, 5] });
    expect(runs(spec, "2026-08-02", 7)).toEqual([
      "2026-08-03", // Mon
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07", // Fri
      "2026-08-10", // Mon, weekend skipped
      "2026-08-11",
    ]);
  });

  it("runs every day when every day is selected", () => {
    const spec = daily({ daysOfWeek: [1, 2, 3, 4, 5, 6, 7] });
    expect(runs(spec, "2026-08-02", 8)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08", // Sat
      "2026-08-09", // Sun
      "2026-08-10",
    ]);
  });

  it("treats no selection as every day", () => {
    for (const daysOfWeek of [undefined, null, [] as number[]]) {
      const spec = daily({ daysOfWeek });
      expect(runs(spec, "2026-08-02", 3)).toEqual([
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
      ]);
    }
  });

  it("behaves weekly when only one day is selected", () => {
    const spec = daily({ daysOfWeek: [3] }); // Wednesdays
    expect(runs(spec, "2026-08-02", 3)).toEqual([
      "2026-08-05",
      "2026-08-12",
      "2026-08-19",
    ]);
  });

  it("collects only at weekends when only weekend days are selected", () => {
    const spec = daily({ daysOfWeek: [6, 7] });
    expect(runs(spec, "2026-08-02", 4)).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-15",
      "2026-08-16",
    ]);
  });
});

describe("daily frequency: start date handling", () => {
  it("moves the first run forward when the start date is not a selected day", () => {
    // Starts on a Saturday but only weekdays are selected.
    const spec = daily({ startDate: SAT, daysOfWeek: [1, 2, 3, 4, 5] });
    expect(runs(spec, "2026-08-07", 2)).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it("never returns a date on or before the date asked about", () => {
    const spec = daily({ daysOfWeek: [1, 2, 3, 4, 5] });
    const next = nextRunDate(spec, {
      afterDate: FRI,
      paymentsMade: 1,
      collectedMinor: 0,
    });
    expect(next).toBe("2026-08-10");
  });

  it("does not run before the start date", () => {
    const spec = daily({ startDate: "2026-09-01", daysOfWeek: [1, 2, 3, 4, 5] });
    const next = nextRunDate(spec, {
      afterDate: "2026-08-03",
      paymentsMade: 0,
      collectedMinor: 0,
    });
    expect(next).toBe("2026-09-01"); // a Tuesday
  });
});

describe("daily frequency: end modes still apply", () => {
  it("stops after the requested number of payments", () => {
    const spec = daily({ daysOfWeek: [1, 2, 3, 4, 5], endMode: "count", endCount: 3 });
    expect(runs(spec, "2026-08-02", 10)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
  });

  it("stops at the end date", () => {
    const spec = daily({
      daysOfWeek: [1, 2, 3, 4, 5],
      endMode: "date",
      endDate: "2026-08-05",
    });
    expect(runs(spec, "2026-08-02", 10)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
  });
});

describe("daily frequency: invalid input", () => {
  it("rejects weekday numbers outside 1 to 7", () => {
    for (const bad of [[0], [8], [1, 9], [-1]]) {
      expect(() => addInterval(MON, daily({ daysOfWeek: bad }))).toThrow(/day of week/i);
    }
  });

  it("rejects non-integer weekdays", () => {
    expect(() => addInterval(MON, daily({ daysOfWeek: [1.5] }))).toThrow(/day of week/i);
  });

  it("tolerates duplicates", () => {
    const spec = daily({ daysOfWeek: [1, 1, 3, 3] });
    expect(runs(spec, "2026-08-02", 3)).toEqual([
      "2026-08-03",
      "2026-08-05",
      "2026-08-10",
    ]);
  });
});

describe("addInterval for daily", () => {
  it("advances one day when every day is allowed", () => {
    expect(addInterval(MON, daily())).toBe("2026-08-04");
  });

  it("jumps the weekend", () => {
    expect(addInterval(FRI, daily({ daysOfWeek: [1, 2, 3, 4, 5] }))).toBe("2026-08-10");
  });
});
