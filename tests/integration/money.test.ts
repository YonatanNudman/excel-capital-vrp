import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MockPlaidClient } from "@/lib/plaid/mock";
import { PlaidTransportError } from "@/lib/plaid";
import { collectPayment } from "@/lib/engine/collect";
import { reconcilePayments } from "@/lib/engine/reconcile";
import { runAutoRetries } from "@/lib/engine/auto-retry";
import { processWebhook } from "@/lib/engine/webhook";
import { runDueCollections } from "@/lib/engine/cron";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";
import { createBorrower, setBorrowerStatus, getBorrower } from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import {
  createPendingConsent,
  attachPlaidConsent,
  setConsentStatus,
} from "@/lib/repo/consents";
import { upsertSchedule } from "@/lib/repo/schedules";
import { getPayment, getPaymentByPlaidId } from "@/lib/repo/payments";
import { encryptString, sha256Hex } from "@/lib/crypto";
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
  const plaidConsentId = `mock-consent-${b.id}`;
  await attachPlaidConsent(env.DB, consent.id, {
    plaidConsentIdEncrypted: await encryptString(plaidConsentId, KEY),
    plaidConsentIdHash: await sha256Hex(plaidConsentId),
    plaidRecipientId: "mock-recipient-1",
  });
  if (opts.authorized !== false) await setConsentStatus(env.DB, consent.id, "authorized");
  return { borrower: b, consent, plaidConsentId };
}

describe("runConsentMaintenance", () => {
  it("expires an overdue consent and flags the borrower, blocking collection", async () => {
    const b = await createBorrower(env.DB, { legalName: "Overdue Ltd", createdBy: null });
    await setBorrowerStatus(env.DB, b.id, "active");
    await upsertRecipient(env.DB, b.id, { name: "Excel Capital" });
    const consent = await createPendingConsent(env.DB, b.id, {
      currency: "GBP",
      validTo: "2020-01-01T00:00:00Z", // already past
    });
    await attachPlaidConsent(env.DB, consent.id, {
      plaidConsentIdEncrypted: await encryptString("mock-consent-x", KEY),
      plaidRecipientId: "mock-recipient-x",
    });
    await setConsentStatus(env.DB, consent.id, "authorized");

    const summary = await runConsentMaintenance(env.DB, new Date("2026-07-17T06:00:00Z"));
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    expect((await getBorrower(env.DB, b.id))?.status).toBe("expired");

    const out = await collectPayment(env.DB, plaid, KEY, {
      borrowerId: b.id,
      amountMinor: 5000,
      reference: "EXP",
      idempotencyKey: manualKey(b.id, newId()),
      actorStaffId: null,
    });
    expect(out.kind).toBe("skipped");
  });
});

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

  it("quarantines a transport timeout and never auto-retries it", async () => {
    const uncertain = new MockPlaidClient();
    uncertain.executePayment = async () => {
      throw new PlaidTransportError("connection closed after request upload");
    };
    const { borrower } = await seedBorrower();
    const out = await collectPayment(env.DB, uncertain, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "TIMEOUT1",
      idempotencyKey: manualKey(borrower.id, newId()),
      actorStaffId: null,
    });
    expect(out.kind).toBe("unknown");
    if (out.kind !== "unknown") throw new Error("expected unknown payment");
    expect((await getPayment(env.DB, out.payment.id))?.status).toBe("unknown");

    const retries = await runAutoRetries(env.DB, plaid, KEY, new Date("2030-01-01T00:00:00Z"));
    expect(retries.considered).toBe(0);
  });

  it("recovers a lost execute response by exact provider reference", async () => {
    const recovering = new MockPlaidClient();
    recovering.executePayment = async () => {
      throw new PlaidTransportError("response lost");
    };
    recovering.listPayments = async () => [{
      paymentId: "provider-recovered-1",
      status: "PAYMENT_STATUS_INITIATED",
      reference: "RECOVER1",
      amountMinor: 5000,
      currency: "GBP",
    }];
    const { borrower } = await seedBorrower();
    const out = await collectPayment(env.DB, recovering, KEY, {
      borrowerId: borrower.id,
      amountMinor: 5000,
      reference: "RECOVER1",
      idempotencyKey: manualKey(borrower.id, newId()),
      actorStaffId: null,
    });
    expect(out.kind).toBe("unknown");

    const summary = await reconcilePayments(
      env.DB,
      recovering,
      KEY,
      new Date(Date.now() + 120_000),
    );
    expect(summary.updated).toBeGreaterThanOrEqual(1);
    if (out.kind !== "unknown") throw new Error("expected unknown payment");
    const recovered = await getPayment(env.DB, out.payment.id);
    expect(recovered?.plaid_payment_id).toBe("provider-recovered-1");
    expect(recovered?.status).toBe("initiated");
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

  function webhook(paymentId: string, status: string, eventId?: string): string {
    return JSON.stringify({
      webhook_type: "PAYMENT_INITIATION",
      payment_id: paymentId,
      new_payment_status: status,
      timestamp: "2026-07-17T06:00:00Z",
      ...(eventId ? { event_id: eventId } : {}),
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

  // Regression guard for the dedupe bug: without an event_id, successive
  // transitions of the same payment must each be processed (not collapsed).
  it("processes successive transitions when no event_id is present", async () => {
    const pid = await collectOne();
    const executed = await processWebhook(env.DB, plaid, webhook(pid, "PAYMENT_STATUS_EXECUTED"), new Headers());
    const settled = await processWebhook(env.DB, plaid, webhook(pid, "PAYMENT_STATUS_SETTLED"), new Headers());
    expect(executed.status).toBe("applied");
    expect(settled.status).toBe("applied");
    expect((await getPaymentByPlaidId(env.DB, pid))?.status).toBe("settled");
  });

  it("rejects an unverified (malformed) webhook without changing state", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events")
      .first<{ n: number }>();
    const pid = await collectOne();
    const res = await processWebhook(env.DB, plaid, "not json", new Headers());
    expect(res.status).toBe("unverified");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events")
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    // A later genuine delivery is still processed (dedupe not poisoned).
    const ok = await processWebhook(env.DB, plaid, webhook(pid, "PAYMENT_STATUS_SETTLED"), new Headers());
    expect(ok.status).toBe("applied");
  });

  it("leaves an early unknown-payment webhook replayable", async () => {
    const body = webhook("not-persisted-yet", "PAYMENT_STATUS_EXECUTED", "evt-early");
    const first = await processWebhook(env.DB, plaid, body, new Headers());
    const second = await processWebhook(env.DB, plaid, body, new Headers());
    expect(first.status).toBe("retry");
    expect(second.status).toBe("retry");
    const event = await env.DB.prepare("SELECT processed_at FROM webhook_events WHERE id = ?")
      .bind("evt-early")
      .first<{ processed_at: string | null }>();
    expect(event?.processed_at).toBeNull();
  });

  it("applies consent revocation and blocks the borrower", async () => {
    const { borrower, consent, plaidConsentId } = await seedBorrower();
    const body = JSON.stringify({
      webhook_type: "PAYMENT_INITIATION",
      consent_id: plaidConsentId,
      new_consent_status: "REVOKED",
      event_id: `consent-revoked-${consent.id}`,
    });
    const result = await processWebhook(env.DB, plaid, body, new Headers());
    expect(result.status).toBe("consent_applied");
    expect((await getBorrower(env.DB, borrower.id))?.status).toBe("revoked");
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
    // Start on the run date so exactly one payment is due (no catch-up). The
    // schedule is saved AS IF on that day: a schedule saved today never becomes
    // due for a date already past (see upsertSchedule).
    await upsertSchedule(
      env.DB,
      borrower.id,
      {
        amountMinor: 20000,
        frequency: "monthly",
        startDate: "2026-02-01",
        endMode: "count",
        endCount: 12,
      },
      { today: "2026-02-01" },
    );
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
    await upsertSchedule(
      env.DB,
      borrower.id,
      {
        amountMinor: 20000,
        frequency: "monthly",
        startDate: "2026-01-01",
        endMode: "count",
        endCount: 12,
      },
      { today: "2026-01-01" },
    );
    const r = await runDueCollections(env.DB, plaid, KEY, "2026-02-01");
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.collected).toBe(0);
  });
});
