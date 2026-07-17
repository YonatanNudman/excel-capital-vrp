import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MockPlaidClient } from "@/lib/plaid/mock";
import { collectPayment } from "@/lib/engine/collect";
import { processWebhook } from "@/lib/engine/webhook";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";
import { createBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import {
  createPendingConsent,
  attachPlaidConsent,
  setConsentStatus,
} from "@/lib/repo/consents";
import { getPayment } from "@/lib/repo/payments";
import { encryptString } from "@/lib/crypto";
import { manualKey } from "@/lib/idempotency";
import { newId } from "@/lib/ids";
import type { EmailMessage, Mailer, MailerResult } from "@/lib/mailer";

const KEY = "test-encryption-key";
const plaid = new MockPlaidClient();

// Captures every send so tests can assert on count and subject without any
// network. mode "log" keeps it a valid Mailer without pretending to be Resend.
class FakeMailer implements Mailer {
  readonly mode = "log" as const;
  sends: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<MailerResult> {
    this.sends.push(msg);
    return { ok: true };
  }
  countBySubject(fragment: string): number {
    return this.sends.filter((m) => m.subject.includes(fragment)).length;
  }
}

async function seedBorrower(
  opts: { contactEmail?: string | null; validTo?: string | null } = {},
) {
  const b = await createBorrower(env.DB, {
    legalName: "Notify Ltd",
    contactEmail: opts.contactEmail === undefined ? "borrower@example.com" : opts.contactEmail,
    createdBy: null,
  });
  await setBorrowerStatus(env.DB, b.id, "active");
  await upsertRecipient(env.DB, b.id, {
    name: "Excel Capital",
    accountNumber: "12345678",
    sortCode: "12-34-56",
  });
  const consent = await createPendingConsent(env.DB, b.id, {
    currency: "GBP",
    maxPaymentAmountMinor: 100000,
    validTo: opts.validTo ?? null,
  });
  await attachPlaidConsent(env.DB, consent.id, {
    plaidConsentIdEncrypted: await encryptString("mock-consent-notify", KEY),
    plaidRecipientId: "mock-recipient-notify",
  });
  await setConsentStatus(env.DB, consent.id, "authorized");
  return { borrower: b, consent };
}

async function collectOne(borrowerId: string): Promise<string> {
  const out = await collectPayment(env.DB, plaid, KEY, {
    borrowerId,
    amountMinor: 5000,
    reference: "NOTIFY",
    idempotencyKey: manualKey(borrowerId, newId()),
    actorStaffId: null,
  });
  if (out.kind !== "collected") throw new Error(`setup collect failed: ${out.kind}`);
  const row = await getPayment(env.DB, out.payment.id);
  return row!.plaid_payment_id!;
}

function webhook(paymentId: string, status: string, eventId: string): string {
  return JSON.stringify({
    webhook_type: "PAYMENT_INITIATION",
    payment_id: paymentId,
    new_payment_status: status,
    timestamp: "2026-07-17T06:00:00Z",
    event_id: eventId,
  });
}

describe("webhook email notifications", () => {
  it("sends exactly one receipt on a settled webhook", async () => {
    const { borrower } = await seedBorrower();
    const pid = await collectOne(borrower.id);
    const mailer = new FakeMailer();

    const res = await processWebhook(
      env.DB,
      plaid,
      webhook(pid, "PAYMENT_STATUS_SETTLED", newId()),
      new Headers(),
      mailer,
    );

    expect(res.status).toBe("applied");
    expect(mailer.countBySubject("Payment received")).toBe(1);
    expect(mailer.sends).toHaveLength(1);
  });

  it("sends a failure email on a failed webhook", async () => {
    const { borrower } = await seedBorrower();
    const pid = await collectOne(borrower.id);
    const mailer = new FakeMailer();

    const res = await processWebhook(
      env.DB,
      plaid,
      webhook(pid, "PAYMENT_STATUS_FAILED", newId()),
      new Headers(),
      mailer,
    );

    expect(res.status).toBe("applied");
    expect(mailer.countBySubject("could not collect")).toBe(1);
    expect(mailer.sends).toHaveLength(1);
  });

  it("does not resend on a duplicate webhook delivery", async () => {
    const { borrower } = await seedBorrower();
    const pid = await collectOne(borrower.id);
    const mailer = new FakeMailer();
    const body = webhook(pid, "PAYMENT_STATUS_SETTLED", newId());

    const first = await processWebhook(env.DB, plaid, body, new Headers(), mailer);
    const second = await processWebhook(env.DB, plaid, body, new Headers(), mailer);

    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");
    expect(mailer.sends).toHaveLength(1);
  });

  it("sends nothing (and does not error) for a borrower without contact_email", async () => {
    const { borrower } = await seedBorrower({ contactEmail: null });
    const pid = await collectOne(borrower.id);
    const mailer = new FakeMailer();

    const res = await processWebhook(
      env.DB,
      plaid,
      webhook(pid, "PAYMENT_STATUS_SETTLED", newId()),
      new Headers(),
      mailer,
    );

    expect(res.status).toBe("applied");
    expect(mailer.sends).toHaveLength(0);
  });
});

describe("re-consent email", () => {
  it("sends the re-consent email once across two maintenance runs", async () => {
    const now = new Date("2026-07-17T06:00:00Z");
    // Expires in 3 days: inside the 7-day expiring-soon window.
    const validTo = new Date(now.getTime() + 3 * 86_400_000).toISOString();
    await seedBorrower({ validTo });

    const mailer = new FakeMailer();
    const first = await runConsentMaintenance(env.DB, now, mailer);
    const second = await runConsentMaintenance(env.DB, now, mailer);

    expect(first.expiringSoon).toBeGreaterThanOrEqual(1);
    expect(second.expiringSoon).toBeGreaterThanOrEqual(1);
    expect(mailer.countBySubject("renew your payment authorisation")).toBe(1);
  });
});
