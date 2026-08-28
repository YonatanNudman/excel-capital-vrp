import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MockPlaidClient } from "@/lib/plaid/mock";
import { runDueCollections } from "@/lib/engine/cron";
import { createBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import {
  attachPlaidConsent,
  createPendingConsent,
  setConsentStatus,
} from "@/lib/repo/consents";
import {
  getActiveSchedule,
  lineageOf,
  setScheduleNextRun,
  upsertSchedule,
} from "@/lib/repo/schedules";
import { collectionProgress } from "@/lib/repo/payments";
import { collectPayment } from "@/lib/engine/collect";
import { scheduledKey } from "@/lib/idempotency";
import { encryptString, sha256Hex } from "@/lib/crypto";
import type { CollectInput, CollectOutcome } from "@/lib/engine/collect";

const KEY = "test-encryption-key";
const plaid = new MockPlaidClient();

let n = 0;

async function seedCollectableBorrower() {
  const b = await createBorrower(env.DB, { legalName: `Edit ${n++} Ltd`, createdBy: null });
  await setBorrowerStatus(env.DB, b.id, "active");
  await upsertRecipient(env.DB, b.id, {
    name: "Excel Capital",
    accountNumber: "12345678",
    sortCode: "123456",
  });
  const consent = await createPendingConsent(env.DB, b.id, {
    currency: "GBP",
    maxPaymentAmountMinor: 100_000,
  });
  const plaidConsentId = `mock-consent-${b.id}`;
  await attachPlaidConsent(env.DB, consent.id, {
    plaidConsentIdEncrypted: await encryptString(plaidConsentId, KEY),
    plaidConsentIdHash: await sha256Hex(plaidConsentId),
    plaidRecipientId: "mock-recipient-1",
  });
  await setConsentStatus(env.DB, consent.id, "authorized");
  return b;
}

async function countPayments(borrowerId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE borrower_id = ?")
    .bind(borrowerId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * The worst defect this codebase has had.
 *
 * Editing a running schedule re-submits its ORIGINAL start date (the form
 * pre-fills it), and upsertSchedule recomputed next_run_date by walking forward
 * from that date. So changing an amount rewound the schedule to the loan's first
 * instalment, and the nightly sweep then collected one backdated payment per
 * night until it caught up with today: for a borrower months into a weekly loan,
 * dozens of further debits of money they had already paid.
 */
describe("editing a schedule cannot re-collect the past", () => {
  it("never leaves a schedule due for a date before today", async () => {
    const b = await seedCollectableBorrower();
    // Saved as if in January, so it is genuinely mid-loan.
    await upsertSchedule(
      env.DB,
      b.id,
      {
        amountMinor: 50_000,
        frequency: "weekly",
        startDate: "2026-01-05",
        endMode: "count",
        endCount: 40,
      },
      { today: "2026-01-05" },
    );

    // The operator changes the amount today. The form re-submits the January
    // start date, exactly as the page renders it.
    const edited = await upsertSchedule(env.DB, b.id, {
      amountMinor: 45_000,
      frequency: "weekly",
      startDate: "2026-01-05",
      endMode: "count",
      endCount: 40,
    });

    const today = new Date().toISOString().slice(0, 10);
    expect(edited.next_run_date).not.toBeNull();
    expect(edited.next_run_date! >= today).toBe(true);
  });

  it("does not backdate a brand-new schedule given a past start date", async () => {
    // Same defect, reached without an edit: a loan entered with its real (past)
    // start date would have been immediately due for every instalment since.
    const b = await seedCollectableBorrower();
    const created = await upsertSchedule(env.DB, b.id, {
      amountMinor: 10_000,
      frequency: "weekly",
      startDate: "2025-01-06",
      endMode: "count",
      endCount: 52,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(created.next_run_date! >= today).toBe(true);
  });

  it("carries the loan's progress across the edit, so it cannot run its term twice", async () => {
    const b = await seedCollectableBorrower();
    await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 20_000, frequency: "monthly", startDate: "2026-02-01", endMode: "count", endCount: 2 },
      { today: "2026-02-01" },
    );
    const collected = await runDueCollections(env.DB, plaid, KEY, "2026-02-01");
    expect(collected.collected).toBe(1);

    // Progress must survive the edit: the row id changes, the loan does not.
    const edited = await upsertSchedule(env.DB, b.id, {
      amountMinor: 25_000,
      frequency: "monthly",
      startDate: "2026-02-01",
      endMode: "count",
      endCount: 2,
    });
    const progress = await collectionProgress(env.DB, b.id, edited.id);
    expect(progress.paymentsMade).toBe(1);
    expect(progress.collectedMinor).toBe(20_000);
  });

  it("keeps the same idempotency identity, so today's payment cannot be taken twice", async () => {
    const b = await seedCollectableBorrower();
    const first = await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 20_000, frequency: "monthly", startDate: "2026-03-01", endMode: "count", endCount: 12 },
      { today: "2026-03-01" },
    );
    await runDueCollections(env.DB, plaid, KEY, "2026-03-01");
    const after = await countPayments(b.id);

    const edited = await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 30_000, frequency: "monthly", startDate: "2026-03-01", endMode: "count", endCount: 12 },
      { today: "2026-03-01" },
    );
    expect(lineageOf(edited)).toBe(lineageOf(first));

    // The same due date, after the edit, must still be recognised as paid.
    await setScheduleNextRun(env.DB, edited.id, "2026-03-01");
    await runDueCollections(env.DB, plaid, KEY, "2026-03-01");
    expect(await countPayments(b.id)).toBe(after);
  });

  it("still records the superseded version, so schedule history survives", async () => {
    const b = await seedCollectableBorrower();
    await upsertSchedule(env.DB, b.id, {
      amountMinor: 10_000, frequency: "weekly", startDate: "2026-09-07", endMode: "count", endCount: 4,
    });
    await upsertSchedule(env.DB, b.id, {
      amountMinor: 11_000, frequency: "weekly", startDate: "2026-09-07", endMode: "count", endCount: 4,
    });
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM repayment_schedules WHERE borrower_id = ?",
    )
      .bind(b.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
    expect((await getActiveSchedule(env.DB, b.id))?.amount_minor).toBe(11_000);
  });
});

describe("the nightly sweep protects itself", () => {
  it("re-anchors a long-overdue schedule instead of collecting the backlog", async () => {
    // A borrower paused for months, or an account retired under a live schedule,
    // used to be met with one full debit per night once the obstruction cleared.
    const b = await seedCollectableBorrower();
    const s = await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 20_000, frequency: "weekly", startDate: "2026-01-05", endMode: "count", endCount: 52 },
      { today: "2026-01-05" },
    );
    await setScheduleNextRun(env.DB, s.id, "2026-01-05");

    // Other borrowers seeded by this file share the database, so assert on THIS
    // borrower rather than on the sweep's global totals.
    const summary = await runDueCollections(env.DB, plaid, KEY, "2026-06-01");

    expect(summary.stale).toBeGreaterThanOrEqual(1);
    expect(await countPayments(b.id)).toBe(0);
    // And it is not left stuck on the stale date, which would retry forever the
    // way an archived destination does. Re-anchored to the current cycle, so the
    // CURRENT instalment is still collected; only the backlog is written off.
    const after = await getActiveSchedule(env.DB, b.id);
    expect(after?.next_run_date).not.toBe("2026-01-05");
    expect((after?.next_run_date ?? "") >= "2026-06-01").toBe(true);
  });

  it("collects a due date that is merely a few days late", async () => {
    const b = await seedCollectableBorrower();
    const s = await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 20_000, frequency: "weekly", startDate: "2026-04-06", endMode: "count", endCount: 52 },
      { today: "2026-04-06" },
    );
    await setScheduleNextRun(env.DB, s.id, "2026-04-06");

    const summary = await runDueCollections(env.DB, plaid, KEY, "2026-04-09");
    expect(summary.collected).toBe(1);
    expect(summary.stale).toBe(0);
  });

  it("one borrower's failure does not cost everyone after them their collection", async () => {
    const bad = await seedCollectableBorrower();
    const good = await seedCollectableBorrower();
    for (const b of [bad, good]) {
      await upsertSchedule(
        env.DB,
        b.id,
        { amountMinor: 20_000, frequency: "monthly", startDate: "2026-05-01", endMode: "count", endCount: 12 },
        { today: "2026-05-01" },
      );
    }

    // `bad` is inserted first, so the sweep reaches it first: before this fix its
    // throw ended the loop and `good` was never attempted.
    const attempted: string[] = [];
    const collector = async (input: CollectInput): Promise<CollectOutcome> => {
      attempted.push(input.borrowerId);
      if (input.borrowerId === bad.id) throw new Error("provider exploded");
      return {
        kind: "collected",
        payment: { id: "x" } as never,
        plaidStatus: "PAYMENT_STATUS_INITIATED",
      };
    };

    const summary = await runDueCollections(env.DB, plaid, KEY, "2026-05-01", undefined, collector);

    expect(summary.errored).toBeGreaterThanOrEqual(1);
    expect(attempted).toContain(bad.id);
    expect(attempted).toContain(good.id);
  });

  it("does not revive a schedule an operator has just superseded", async () => {
    // The sweep reads its list once and advances each row afterwards. Reviving a
    // superseded row would put two active schedules on one borrower, which the
    // unique index rejects, taking the rest of the night's collections with it.
    const b = await seedCollectableBorrower();
    const first = await upsertSchedule(env.DB, b.id, {
      amountMinor: 10_000, frequency: "weekly", startDate: "2026-09-07", endMode: "count", endCount: 4,
    });
    await upsertSchedule(env.DB, b.id, {
      amountMinor: 12_000, frequency: "weekly", startDate: "2026-09-07", endMode: "count", endCount: 4,
    });

    await setScheduleNextRun(env.DB, first.id, "2026-09-14");

    const revived = await env.DB.prepare("SELECT active FROM repayment_schedules WHERE id = ?")
      .bind(first.id)
      .first<{ active: number }>();
    expect(revived?.active).toBe(0);
  });
});

/**
 * "Execute payment now" pressed BEFORE the due date.
 *
 * isScheduledRun required next_run_date <= today, which is false for most of the
 * week on any schedule the sweep has already advanced, so an early press fell
 * through to the ad-hoc path: schedule_id NULL, a fresh random key per render.
 * The instalment was then invisible to the "already sent today" guard, invisible
 * to the loan total, and collected again by the sweep on its due date. The action
 * now collects it as the instalment it is, under the sweep's own deterministic
 * key, which is what makes all three impossible. This pins that key's behaviour,
 * which is the part that has to hold.
 */
describe("collecting an instalment early", () => {
  it("cannot be collected a second time by the sweep on its due date", async () => {
    const b = await seedCollectableBorrower();
    const schedule = await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 20_000, frequency: "monthly", startDate: "2026-07-01", endMode: "count", endCount: 12 },
      { today: "2026-07-01" },
    );
    const dueDate = schedule.next_run_date!;

    // The early press: same key the sweep will compute for that due date.
    const early = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: b.id,
      amountMinor: 20_000,
      reference: "ExcelEarly",
      idempotencyKey: scheduledKey(b.id, lineageOf(schedule), dueDate),
      scheduleId: schedule.id,
      scheduledFor: dueDate,
      actorStaffId: null,
    });
    expect(early.kind).toBe("collected");
    const afterEarly = await countPayments(b.id);

    // Other borrowers in this file share the database, so the sweep's global
    // totals say nothing; this borrower's payment count is the assertion.
    await runDueCollections(env.DB, plaid, KEY, dueDate);

    expect(await countPayments(b.id)).toBe(afterEarly);
  });

  it("counts towards the loan, so the schedule cannot run past its end", async () => {
    const b = await seedCollectableBorrower();
    const schedule = await upsertSchedule(
      env.DB,
      b.id,
      { amountMinor: 20_000, frequency: "monthly", startDate: "2026-07-01", endMode: "count", endCount: 1 },
      { today: "2026-07-01" },
    );
    await collectPayment(env.DB, plaid, KEY, {
      borrowerId: b.id,
      amountMinor: 20_000,
      reference: "ExcelEarly2",
      idempotencyKey: scheduledKey(b.id, lineageOf(schedule), schedule.next_run_date!),
      scheduleId: schedule.id,
      scheduledFor: schedule.next_run_date,
      actorStaffId: null,
    });

    const progress = await collectionProgress(env.DB, b.id, schedule.id);
    expect(progress.paymentsMade).toBe(1);
    expect(progress.collectedMinor).toBe(20_000);
  });
});

describe("the weekday an operator picks", () => {
  it("is stored for a weekly schedule, not silently dropped", async () => {
    // The form promises this in as many words ("For Weekly or Fortnightly: tick
    // the one day you want"), and lib/schedule.ts implements it; only the
    // storage encoding threw the choice away, so collections landed on whatever
    // weekday the start date happened to be.
    const b = await seedCollectableBorrower();
    const created = await upsertSchedule(
      env.DB,
      b.id,
      {
        amountMinor: 10_000,
        frequency: "weekly",
        daysOfWeek: [2], // Tuesday
        startDate: "2026-09-03", // a Thursday
        endMode: "count",
        endCount: 10,
      },
      { today: "2026-09-03" },
    );
    expect(created.days_of_week).toBe("2");
    expect(created.next_run_date).toBe("2026-09-08"); // the following Tuesday
  });
});
