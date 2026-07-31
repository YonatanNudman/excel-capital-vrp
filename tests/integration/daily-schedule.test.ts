import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import {
  upsertSchedule,
  getActiveSchedule,
  parseDaysOfWeek,
  formatDaysOfWeek,
  toSpec,
} from "@/lib/repo/schedules";
import { nextRunDate } from "@/lib/schedule";

async function seedBorrower(name: string) {
  const b = await createBorrower(env.DB, { legalName: name, createdBy: null });
  await setBorrowerStatus(env.DB, b.id, "active");
  return b;
}

describe("daily schedules round-trip through D1", () => {
  it("stores selected weekdays and reads them back", async () => {
    const b = await seedBorrower("Weekday Ltd");
    const created = await upsertSchedule(env.DB, b.id, {
      amountMinor: 25_000,
      frequency: "daily",
      daysOfWeek: [1, 2, 3, 4, 5],
      startDate: "2026-08-03", // Monday
      endMode: "count",
      endCount: 20,
    });

    // Stored as custom/1-day plus the weekday list (see migrations/0004).
    expect(created.frequency).toBe("custom");
    expect(created.interval_days).toBe(1);
    expect(created.days_of_week).toBe("1,2,3,4,5");

    const loaded = await getActiveSchedule(env.DB, b.id);
    expect(parseDaysOfWeek(loaded!.days_of_week)).toEqual([1, 2, 3, 4, 5]);
    // The spec rebuilt from the row must read back as daily and schedule the same way.
    expect(toSpec(loaded!).frequency).toBe("daily");
    expect(toSpec(loaded!).daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("sets the first run to a selected weekday, not the raw start date", async () => {
    const b = await seedBorrower("Saturday Start Ltd");
    const created = await upsertSchedule(env.DB, b.id, {
      amountMinor: 10_000,
      frequency: "daily",
      daysOfWeek: [1, 2, 3, 4, 5],
      startDate: "2026-08-08", // a Saturday
      endMode: "count",
      endCount: 5,
    });
    expect(created.next_run_date).toBe("2026-08-10"); // the Monday
  });

  it("skips the weekend when advancing a stored weekday schedule", async () => {
    const b = await seedBorrower("Advance Ltd");
    const created = await upsertSchedule(env.DB, b.id, {
      amountMinor: 10_000,
      frequency: "daily",
      daysOfWeek: [1, 2, 3, 4, 5],
      startDate: "2026-08-03",
      endMode: "count",
      endCount: 20,
    });

    const afterFriday = nextRunDate(toSpec(created), {
      afterDate: "2026-08-07",
      paymentsMade: 5,
      collectedMinor: 50_000,
    });
    expect(afterFriday).toBe("2026-08-10");
  });

  it("stores every-day as null rather than a list of all seven", async () => {
    const b = await seedBorrower("Every Day Ltd");
    const created = await upsertSchedule(env.DB, b.id, {
      amountMinor: 5_000,
      frequency: "daily",
      daysOfWeek: null,
      startDate: "2026-08-03",
      endMode: "count",
      endCount: 10,
    });
    // Nothing ticked stores all seven explicitly, which is what makes the row
    // recognisable as daily rather than an ordinary 1-day custom schedule.
    expect(created.days_of_week).toBe("1,2,3,4,5,6,7");
    expect(created.next_run_date).toBe("2026-08-03");
    expect(toSpec(created).frequency).toBe("daily");
  });

  it("rejects an out-of-range weekday before touching the database", async () => {
    const b = await seedBorrower("Bad Day Ltd");
    await expect(
      upsertSchedule(env.DB, b.id, {
        amountMinor: 5_000,
        frequency: "daily",
        daysOfWeek: [0, 8],
        startDate: "2026-08-03",
        endMode: "count",
        endCount: 10,
      }),
    ).rejects.toThrow(/Monday|Sunday|between/i);
    expect(await getActiveSchedule(env.DB, b.id)).toBeNull();
  });

  it("leaves the other frequencies untouched by the migration", async () => {
    const b = await seedBorrower("Monthly Ltd");
    const created = await upsertSchedule(env.DB, b.id, {
      amountMinor: 75_000,
      frequency: "monthly",
      startDate: "2026-08-17",
      endMode: "count",
      endCount: 12,
    });
    expect(created.frequency).toBe("monthly");
    expect(created.days_of_week).toBeNull();
    expect(created.next_run_date).toBe("2026-08-17");
  });
});

describe("weekday storage format", () => {
  it("normalises to sorted, de-duplicated, comma separated", () => {
    expect(formatDaysOfWeek([5, 1, 3, 1])).toBe("1,3,5");
    expect(formatDaysOfWeek([])).toBeNull();
    expect(formatDaysOfWeek(null)).toBeNull();
  });

  it("ignores rubbish in a stored value rather than throwing at read time", () => {
    expect(parseDaysOfWeek("1,,x,3,99")).toEqual([1, 3]);
    expect(parseDaysOfWeek("")).toBeNull();
    expect(parseDaysOfWeek("nonsense")).toBeNull();
  });
});

describe("migration 0004 did not damage foreign keys", () => {
  // 0004 is now a plain ADD COLUMN, precisely to avoid this. Renaming a
  // referenced table makes SQLite rewrite FK clauses in child tables, and
  // dropping one that payments references makes D1 roll the database back.
  it("keeps payments and payment_intents pointing at repayment_schedules", async () => {
    const rows = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('payments','payment_intents')",
    ).all<{ name: string; sql: string }>();

    expect(rows.results.length).toBe(2);
    for (const t of rows.results) {
      expect(t.sql).toMatch(/REFERENCES repayment_schedules\(id\)/);
      expect(t.sql).not.toMatch(/repayment_schedules_(legacy|v2)/);
    }
  });

  it("leaves no leftover rebuild table behind", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'repayment_schedules%'",
    ).all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["repayment_schedules"]);
  });
});

describe("borrower registered address (migration 0005)", () => {
  it("stores and reads back the registered office and postcode", async () => {
    const { createBorrower, getBorrower } = await import("@/lib/repo/borrowers");
    const b = await createBorrower(env.DB, {
      legalName: "REGISTERED OFFICE LTD",
      companyNumber: "17104767",
      registeredAddress: "Unit 4, 12 High Street, London, EC1A 1AA, England",
      registeredPostcode: "EC1A 1AA",
      createdBy: null,
    });
    const loaded = await getBorrower(env.DB, b.id);
    expect(loaded?.registered_address).toBe(
      "Unit 4, 12 High Street, London, EC1A 1AA, England",
    );
    expect(loaded?.registered_postcode).toBe("EC1A 1AA");
  });

  it("leaves the address null for a borrower entered by hand", async () => {
    const { createBorrower, getBorrower } = await import("@/lib/repo/borrowers");
    const b = await createBorrower(env.DB, {
      legalName: "MANUAL ENTRY LTD",
      createdBy: null,
    });
    const loaded = await getBorrower(env.DB, b.id);
    expect(loaded?.registered_address).toBeNull();
    expect(loaded?.registered_postcode).toBeNull();
  });
});
