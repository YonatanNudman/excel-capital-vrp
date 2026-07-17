import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { MockPlaidClient } from "@/lib/plaid/mock";
import { PlaidApiError } from "@/lib/plaid";
import type {
  PlaidClient,
  CreateRecipientResult,
  CreateConsentResult,
  CreateLinkTokenResult,
  GetConsentResult,
  ExecutePaymentResult,
  GetPaymentResult,
  WebhookVerification,
} from "@/lib/plaid";
import { collectPayment } from "@/lib/engine/collect";
import { runAutoRetries } from "@/lib/engine/auto-retry";
import { createBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import {
  createPendingConsent,
  attachPlaidConsent,
  setConsentStatus,
} from "@/lib/repo/consents";
import { encryptString } from "@/lib/crypto";
import { manualKey, retryKey } from "@/lib/idempotency";
import { newId } from "@/lib/ids";
import type { Payment } from "@/lib/types";

const KEY = "test-encryption-key";
const success = new MockPlaidClient();

// A fixed "now" so the spacing window is deterministic (default is 24h).
const NOW = new Date("2026-07-17T12:00:00Z");
const AGED = "2026-07-01T00:00:00Z"; // well past the 24h window
const FRESH = "2026-07-17T11:30:00Z"; // 30 minutes before NOW (inside the window)

/**
 * A PlaidClient whose executePayment always throws, so collectPayment records a
 * "failed" payment row. Only executePayment is exercised by these tests; the
 * other members satisfy the interface and are never called.
 */
class FailingPlaidClient implements PlaidClient {
  readonly mode = "mock" as const;
  async createRecipient(): Promise<CreateRecipientResult> {
    throw new Error("FailingPlaidClient: not used");
  }
  async createConsent(): Promise<CreateConsentResult> {
    throw new Error("FailingPlaidClient: not used");
  }
  async createLinkToken(): Promise<CreateLinkTokenResult> {
    throw new Error("FailingPlaidClient: not used");
  }
  async getConsent(): Promise<GetConsentResult> {
    throw new Error("FailingPlaidClient: not used");
  }
  async executePayment(): Promise<ExecutePaymentResult> {
    throw new PlaidApiError("PAYMENT_STATUS_INSUFFICIENT_FUNDS", "insufficient funds", 400);
  }
  async getPayment(): Promise<GetPaymentResult> {
    throw new Error("FailingPlaidClient: not used");
  }
  async verifyWebhook(): Promise<WebhookVerification> {
    throw new Error("FailingPlaidClient: not used");
  }
}

const failing = new FailingPlaidClient();

async function countPayments(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments").first<{ n: number }>();
  return r?.n ?? 0;
}

async function seedBorrower() {
  const b = await createBorrower(env.DB, { legalName: "Acme Ltd", createdBy: null });
  await setBorrowerStatus(env.DB, b.id, "active");
  await upsertRecipient(env.DB, b.id, {
    name: "Excel Capital",
    accountNumber: "12345678",
    sortCode: "12-34-56",
  });
  const consent = await createPendingConsent(env.DB, b.id, {
    currency: "GBP",
    maxPaymentAmountMinor: 100000,
  });
  await attachPlaidConsent(env.DB, consent.id, {
    plaidConsentIdEncrypted: await encryptString("mock-consent-1", KEY),
    plaidRecipientId: "mock-recipient-1",
  });
  await setConsentStatus(env.DB, consent.id, "authorized");
  return b;
}

/** Create a single failed payment (chain root) for a borrower via collectPayment. */
async function seedFailedRoot(borrowerId: string): Promise<string> {
  const out = await collectPayment(env.DB, failing, KEY, {
    borrowerId,
    amountMinor: 5000,
    reference: "REF",
    idempotencyKey: manualKey(borrowerId, newId()),
    actorStaffId: null,
  });
  if (out.kind !== "failed") throw new Error(`expected failed seed, got ${out.kind}`);
  return out.payment.id;
}

async function setLastStatusAt(paymentId: string, iso: string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET last_status_at = ? WHERE id = ?")
    .bind(iso, paymentId)
    .run();
}

async function getPaymentRow(id: string): Promise<Payment | null> {
  return env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<Payment>();
}

describe("runAutoRetries", () => {
  // runAutoRetries scans the whole payments table, and this pool shares storage
  // across tests in a file, so reset payments (and the retry policy) before each
  // test to keep the whole-DB summary counts deterministic.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM payments").run();
    await env.DB.prepare(
      "UPDATE settings SET default_retry_max = 3, default_retry_spacing_hours = 24 WHERE id = 'singleton'",
    ).run();
  });

  it("retries an aged failed payment exactly once and it succeeds", async () => {
    const b = await seedBorrower();
    const root = await seedFailedRoot(b.id);
    await setLastStatusAt(root, AGED);

    const before = await countPayments();
    const summary = await runAutoRetries(env.DB, success, KEY, NOW);

    expect(summary.considered).toBe(1);
    expect(summary.retried).toBe(1);
    expect(await countPayments()).toBe(before + 1);

    const retries = await env.DB.prepare("SELECT * FROM payments WHERE retry_of = ?")
      .bind(root)
      .all<Payment>();
    expect(retries.results.length).toBe(1);
    expect(retries.results[0].retry_of).toBe(root);
    expect(retries.results[0].status).toBe("initiated");
  });

  it("does nothing on an immediate re-run after a successful retry", async () => {
    const b = await seedBorrower();
    const root = await seedFailedRoot(b.id);
    await setLastStatusAt(root, AGED);

    const first = await runAutoRetries(env.DB, success, KEY, NOW);
    expect(first.retried).toBe(1);

    const countAfterFirst = await countPayments();
    // Latest attempt in the chain is now the initiated retry, not a failure.
    const second = await runAutoRetries(env.DB, success, KEY, NOW);
    expect(second.considered).toBe(0);
    expect(second.retried).toBe(0);
    expect(await countPayments()).toBe(countAfterFirst);
  });

  it("does not retry a failure still inside the spacing window", async () => {
    const b = await seedBorrower();
    const root = await seedFailedRoot(b.id);
    await setLastStatusAt(root, FRESH);

    const before = await countPayments();
    const summary = await runAutoRetries(env.DB, success, KEY, NOW);

    expect(summary.considered).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.retried).toBe(0);
    expect(await countPayments()).toBe(before);
  });

  it("stops once the retry limit has been reached", async () => {
    const b = await seedBorrower();
    // Lower the limit so a short chain is already at the cap.
    await env.DB.prepare("UPDATE settings SET default_retry_max = ? WHERE id = 'singleton'")
      .bind(2)
      .run();

    const root = await seedFailedRoot(b.id);
    // Two failed retries chained to the root: attempts so far = 2, next = 3 > 2.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await collectPayment(env.DB, failing, KEY, {
        borrowerId: b.id,
        amountMinor: 5000,
        reference: "REF",
        idempotencyKey: retryKey(root, attempt),
        retryOf: root,
        actorStaffId: null,
      });
      expect(out.kind).toBe("failed");
    }
    // Age every attempt so the spacing gate is not the reason for skipping.
    await env.DB.prepare("UPDATE payments SET last_status_at = ? WHERE borrower_id = ?")
      .bind(AGED, b.id)
      .run();

    const before = await countPayments();
    const summary = await runAutoRetries(env.DB, success, KEY, NOW);

    expect(summary.considered).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.retried).toBe(0);
    expect(await countPayments()).toBe(before);
  });

  it("does not collect for a paused borrower (counts as skipped)", async () => {
    const b = await seedBorrower();
    const root = await seedFailedRoot(b.id);
    await setLastStatusAt(root, AGED);
    await setBorrowerStatus(env.DB, b.id, "paused");

    const before = await countPayments();
    const summary = await runAutoRetries(env.DB, success, KEY, NOW);

    expect(summary.considered).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.retried).toBe(0);
    // collectPayment bails before inserting, so no new row exists.
    expect(await countPayments()).toBe(before);
    // The root is untouched (still failed).
    expect((await getPaymentRow(root))?.status).toBe("failed");
  });
});
