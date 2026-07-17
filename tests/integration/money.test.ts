import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MockPlaidClient } from "@/lib/plaid/mock";
import { collectPayment } from "@/lib/engine/collect";
import { processWebhook } from "@/lib/engine/webhook";
import { runDueCollections } from "@/lib/engine/cron";
import { createBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import {
  createPendingConsent,
  attachPlaidConsent,
  setConsentStatus,
} from "@/lib/repo/consents";
import { upsertSchedule } from "@/lib/repo/schedules";
import { getPayment, getPaymentByPlaidId } from "@/lib/repo/payments";
import { encryptString } from "@/lib/crypto";
import { manualKey } from "@/lib/idempotency";
import { newId } from "@/lib/ids";

const KEY = "test-encryption-key";
const plaid = new MockPlaidClient();

async function countPayments(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments").first<{ n: number }>();
  return r?.n ?? 0;
}

async function seedBorrower(opts: { authorized?: boolean } = {}) {
  const b = await createBorrower(env.DB, { legalName: "Acme Ltd", createdBy: null });
  await setBorrowerStatus(env.DB, b.id, "active");
  await upsertRecipient(env.DB, b.id, { name: "Excel Capital", accountNumber: "12345678", sortCode: "12-34-56" });
  const consent = await createPendingConsent(env.DB, b.id, {
    currency: "GBP",
    maxPaymentAmountMinor: 100000,
  });
  await attachPlaidConsent(env.DB, consent.id, {
    plaidConsentIdEncrypted: await encryptString("mock-consent-1", KEY),
    plaidRecipientId: "mock-recipient-1",
  });
  if (opts.authorized !== false) await setConsentStatus(env.DB, consent.id, "authorized");
  return { borrower: b, consent };
}

describe("collectPayment (D1 + mock Plaid)", () => {
  // Eval #1: same idempotency key twice -> exactly one payment.
  it("blocks double-collection via the idempotency key", async () => {
    const { borrower } = await seedBorrower();
    const key = manualKey(borrower.id, "fixed-nonce");
    const before = await countPayments();

    const first = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "REF1",
      idempotencyKey: key,
      actorStaffId: null,
    });
    const second = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "REF1",
      idempotencyKey: key,
      actorStaffId: null,
    });

    expect(first.kind).toBe("collected");
    expect(second.kind).toBe("duplicate");
    expect(await countPayments()).toBe(before + 1);
  });

  // Eval: INITIATED is stored as submitted-success, not failure.
  it("stores INITIATED as internal 'initiated'", async () => {
    const { borrower } = await seedBorrower();
    const out = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "REF2",
      idempotencyKey: manualKey(borrower.id, newId()),
      actorStaffId: null,
    });
    expect(out.kind).toBe("collected");
    if (out.kind === "collected") expect(out.payment.status === "initiated").toBe(true);
  });

  // Eval #4: revoked/unauthorised consent -> no execution.
  it("skips when consent is not authorised", async () => {
    const { borrower, consent } = await seedBorrower();
    await setConsentStatus(env.DB, consent.id, "revoked");
    const out = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "REF3",
      idempotencyKey: manualKey(borrower.id, newId()),
      actorStaffId: null,
    });
    expect(out.kind).toBe("skipped");
  });

  // Eval #7: paused borrower -> skipped.
  it("skips when the borrower is paused", async () => {
    const { borrower } = await seedBorrower();
    await setBorrowerStatus(env.DB, borrower.id, "paused");
    const out = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "REF4",
      idempotencyKey: manualKey(borrower.id, newId()),
      actorStaffId: null,
    });
    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") expect(out.reason).toContain("paused");
  });
});

describe("processWebhook (D1 + mock Plaid)", () => {
  async function collectOne() {
    const { borrower } = await seedBorrower();
    const out = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "WHK",
      idempotencyKey: manualKey(borrower.id, newId()),
      actorStaffId: null,
    });
    if (out.kind !== "collected") throw new Error("setup collect failed");
    // plaid_payment_id is set after insert, so re-read the row.
    const row = await getPayment(env.DB, out.payment.id);
    return row!.plaid_payment_id!;
  }

  function webhook(paymentId: string, status: string, eventId: string): string {
    return JSON.stringify({
      webhook_type: "PAYMENT_INITIATION",
      payment_id: paymentId,
      new_payment_status: status,
      event_id: eventId,
    });
  }

  it("applies a forward status transition", async () => {
    const pid = await collectOne();
    const res = await processWebhook(env.DB, plaid, webhook(pid, "PAYMENT_STATUS_SETTLED", "evt-1"), new Headers());
    expect(res.status).toBe("applied");
    const p = await getPaymentByPlaidId(env.DB, pid);
    expect(p?.status).toBe("settled");
  });

  // Eval #5: duplicate webhook delivery processed once.
  it("dedupes duplicate deliveries by event id", async () => {
    const pid = await collectOne();
    const body = webhook(pid, "PAYMENT_STATUS_EXECUTED", "evt-dup");
    const first = await processWebhook(env.DB, plaid, body, new Headers());
    const second = await processWebhook(env.DB, plaid, body, new Headers());
    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");
  });

  // Eval: a late 'failed' after 'settled' (terminal) is ignored.
  it("does not regress a terminal (settled) payment", async () => {
    const pid = await collectOne();
    await processWebhook(env.DB, plaid, webhook(pid, "PAYMENT_STATUS_SETTLED", "evt-a"), new Headers());
    const late = await processWebhook(env.DB, plaid, webhook(pid, "PAYMENT_STATUS_FAILED", "evt-b"), new Headers());
    expect(late.status).toBe("no_change");
    const p = await getPaymentByPlaidId(env.DB, pid);
    expect(p?.status).toBe("settled");
  });
});

describe("runDueCollections (cron)", () => {
  it("collects a due schedule once, then nothing on a same-day re-run", async () => {
    const { borrower } = await seedBorrower();
    // Start on the run date so exactly one payment is due (no catch-up).
    await upsertSchedule(env.DB, borrower.id, {
      amountMinor: 20000,
      frequency: "monthly",
      startDate: "2026-02-01",
      endMode: "count",
      endCount: 12,
    });
    const before = await countPayments();

    const r1 = await runDueCollections(env.DB, plaid, KEY, "2026-02-01");
    const r2 = await runDueCollections(env.DB, plaid, KEY, "2026-02-01");

    expect(r1.collected).toBe(1);
    // Schedule advanced to next month; nothing due on a same-day re-run.
    expect(r2.collected).toBe(0);
    expect(await countPayments()).toBe(before + 1);
  });

  it("skips a paused borrower without advancing", async () => {
    const { borrower } = await seedBorrower();
    await setBorrowerStatus(env.DB, borrower.id, "paused");
    await upsertSchedule(env.DB, borrower.id, {
      amountMinor: 20000,
      frequency: "monthly",
      startDate: "2026-01-01",
      endMode: "count",
      endCount: 12,
    });
    const r = await runDueCollections(env.DB, plaid, KEY, "2026-02-01");
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.collected).toBe(0);
  });
});
