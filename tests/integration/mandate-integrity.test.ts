import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MockPlaidClient } from "@/lib/plaid/mock";
import { provisionLinkToken } from "@/lib/engine/setup";
import { processWebhook } from "@/lib/engine/webhook";
import { runAutoRetries } from "@/lib/engine/auto-retry";
import { createBorrower, setBorrowerStatus, getBorrower } from "@/lib/repo/borrowers";
import { upsertRecipient, getRecipient } from "@/lib/repo/recipients";
import {
  addRecipient,
  archiveRecipient,
  listDestinations,
  updateRecipient,
} from "@/lib/repo/destinations";
import {
  createPendingConsent,
  getConsent,
  setConsentStatus,
  updateUnauthorisedConsentLimits,
} from "@/lib/repo/consents";
import { getActiveSchedule, upsertSchedule } from "@/lib/repo/schedules";
import { insertPayment } from "@/lib/repo/payments";
import { protectString, encryptString, sha256Hex } from "@/lib/crypto";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";
import type { PlaidClient } from "@/lib/plaid";

const KEY = "test-encryption-key";
const plaid = new MockPlaidClient();
const ENV = { PLAID_WEBHOOK_URL: undefined, APP_BASE_URL: undefined };

let n = 0;
const borrower = () =>
  createBorrower(env.DB, { legalName: `Mandate ${n++} Ltd`, createdBy: null });

async function seedForProvisioning() {
  const b = await borrower();
  const recipient = await addRecipient(env.DB, b.id, {
    name: "Excel Capital",
    label: "Main",
    accountNumber: await protectString("12345678", KEY),
    sortCode: await protectString("123456", KEY),
  });
  const consent = await createPendingConsent(env.DB, b.id, {
    recipientId: recipient.id,
    currency: "GBP",
    maxPaymentAmountMinor: 50_000,
    periodicMaxAmountMinor: 200_000,
    period: "MONTH",
  });
  return { borrowerId: b.id, recipient, consent };
}

/**
 * Plaid registers a recipient once, from the account details we hand it, and
 * binds the mandate to that registration. Correcting the account number here
 * therefore has to detach it, or the borrower approves a mandate that pays the
 * account we no longer show anywhere.
 */
describe("correcting bank details after the borrower has been sent a link", () => {
  it("detaches the mandate from Plaid so the corrected account is registered", async () => {
    const { borrowerId, recipient, consent } = await seedForProvisioning();
    await provisionLinkToken(env.DB, plaid, KEY, ENV, borrowerId);

    const provisioned = await getRecipient(env.DB, borrowerId);
    expect(provisioned?.plaid_recipient_id).toBeTruthy();
    expect((await getConsent(env.DB, consent.id))?.plaid_consent_id).toBeTruthy();

    // The operator spots a typo in the account number and fixes it.
    const result = await updateRecipient(env.DB, recipient.id, {
      name: "Excel Capital",
      accountNumber: await protectString("87654321", KEY),
      sortCode: await protectString("123456", KEY),
    });

    expect(result.detachedFromPlaid).toBe(true);
    const after = await getRecipient(env.DB, borrowerId);
    expect(after?.plaid_recipient_id).toBeNull();
    // The mandate bound to the old registration cannot be reused either.
    expect((await getConsent(env.DB, consent.id))?.plaid_consent_id).toBeNull();
  });

  it("leaves an authorised mandate alone, since the bank holds those details", async () => {
    const { borrowerId, recipient, consent } = await seedForProvisioning();
    await provisionLinkToken(env.DB, plaid, KEY, ENV, borrowerId);
    await setConsentStatus(env.DB, consent.id, "authorized");

    await updateRecipient(env.DB, recipient.id, {
      name: "Excel Capital",
      accountNumber: await protectString("87654321", KEY),
      sortCode: await protectString("123456", KEY),
    });

    expect((await getConsent(env.DB, consent.id))?.plaid_consent_id).toBeTruthy();
    void borrowerId;
  });

  it("does not detach when only the account NAME changes", async () => {
    const { borrowerId, recipient } = await seedForProvisioning();
    await provisionLinkToken(env.DB, plaid, KEY, ENV, borrowerId);
    const before = await getRecipient(env.DB, borrowerId);

    const result = await updateRecipient(env.DB, recipient.id, { name: "Excel Capital Group Ltd" });

    expect(result.detachedFromPlaid).toBe(false);
    expect((await getRecipient(env.DB, borrowerId))?.plaid_recipient_id).toBe(
      before?.plaid_recipient_id,
    );
  });
});

describe("changing the limits after the mandate exists at the bank", () => {
  it("requires the borrower to approve the new limits", async () => {
    // Plaid fixes the constraints when the consent object is created, which
    // happens at provisioning while our row is still 'pending'. Editing our copy
    // afterwards left our caps disagreeing with the borrower's bank.
    const { borrowerId, consent } = await seedForProvisioning();
    await provisionLinkToken(env.DB, plaid, KEY, ENV, borrowerId);

    const result = await updateUnauthorisedConsentLimits(env.DB, consent.id, {
      maxPaymentAmountMinor: 90_000,
      periodicMaxAmountMinor: 300_000,
      period: "MONTH",
    });

    expect(result.updated).toBe(true);
    expect(result.needsReapproval).toBe(true);
    expect((await getConsent(env.DB, consent.id))?.plaid_consent_id).toBeNull();
  });

  it("does not disturb the mandate when nothing actually changed", async () => {
    const { borrowerId, consent } = await seedForProvisioning();
    await provisionLinkToken(env.DB, plaid, KEY, ENV, borrowerId);

    const result = await updateUnauthorisedConsentLimits(env.DB, consent.id, {
      maxPaymentAmountMinor: 50_000,
      periodicMaxAmountMinor: 200_000,
      period: "MONTH",
    });

    expect(result.needsReapproval).toBe(false);
    expect((await getConsent(env.DB, consent.id))?.plaid_consent_id).toBeTruthy();
  });
});

describe("re-consent after a borrower cancels at their bank", () => {
  it("carries the schedule onto the replacement mandate", async () => {
    // Otherwise the schedule keeps pointing at the revoked mandate, is skipped
    // on every pass, and the borrower's repayments never resume even though they
    // have re-approved.
    const { borrowerId, consent } = await seedForProvisioning();
    await setConsentStatus(env.DB, consent.id, "authorized");
    await upsertSchedule(env.DB, borrowerId, {
      amountMinor: 10_000,
      frequency: "monthly",
      startDate: "2026-09-01",
      endMode: "count",
      endCount: 6,
      consentId: consent.id,
    });
    await setConsentStatus(env.DB, consent.id, "revoked");

    await provisionLinkToken(env.DB, plaid, KEY, ENV, borrowerId);

    const schedule = await getActiveSchedule(env.DB, borrowerId);
    expect(schedule?.consent_id).not.toBe(consent.id);
    const replacement = await getConsent(env.DB, schedule!.consent_id!);
    expect(replacement?.status).toBe("pending");
    expect(replacement?.max_payment_amount_minor).toBe(50_000);
  });
});

describe("retiring a payout account", () => {
  it("refuses while the repayment schedule still pays into it", async () => {
    // Archiving it does not stop the schedule: every night it resolves a retired
    // account, skips without advancing, and tries again. Repayments stop dead
    // with nothing on screen to say why.
    const { borrowerId, consent } = await seedForProvisioning();
    await setConsentStatus(env.DB, consent.id, "authorized");
    const spare = await addRecipient(env.DB, borrowerId, {
      name: "Spare",
      label: "Spare",
      accountNumber: await protectString("22222222", KEY),
      sortCode: await protectString("222222", KEY),
      makeDefault: true,
    });
    await upsertSchedule(env.DB, borrowerId, {
      amountMinor: 10_000,
      frequency: "monthly",
      startDate: "2026-09-01",
      endMode: "count",
      endCount: 6,
      consentId: consent.id,
    });

    const destinations = await listDestinations(env.DB, borrowerId);
    const pinned = destinations.find((d) => d.consent?.id === consent.id)!;
    const result = await archiveRecipient(env.DB, borrowerId, pinned.recipient!.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/schedule/i);
    void spare;
  });
});

describe("the borrower's first account", () => {
  it("is their default, so the guards written around the default actually fire", async () => {
    const b = await borrower();
    await upsertRecipient(env.DB, b.id, {
      name: "Excel Capital",
      accountNumber: "12345678",
      sortCode: "123456",
    });
    expect((await getRecipient(env.DB, b.id))?.is_default).toBe(1);
  });
});

describe("a stale consent webhook", () => {
  it("cannot revive a mandate the borrower cancelled", async () => {
    const b = await borrower();
    await setBorrowerStatus(env.DB, b.id, "active");
    const recipient = await addRecipient(env.DB, b.id, {
      name: "Excel Capital",
      accountNumber: await protectString("12345678", KEY),
      sortCode: await protectString("123456", KEY),
    });
    const consent = await createPendingConsent(env.DB, b.id, {
      recipientId: recipient.id,
      currency: "GBP",
      maxPaymentAmountMinor: 50_000,
    });
    const plaidConsentId = `mock-consent-stale-${b.id}`;
    await env.DB.prepare(
      "UPDATE consents SET plaid_consent_id = ?, plaid_consent_id_hash = ? WHERE id = ?",
    )
      .bind(await encryptString(plaidConsentId, KEY), await sha256Hex(plaidConsentId), consent.id)
      .run();
    await setConsentStatus(env.DB, consent.id, "revoked");
    await setBorrowerStatus(env.DB, b.id, "revoked");

    // A delayed redelivery of the earlier authorisation. Deduping is by event id,
    // which says nothing about ordering.
    const body = JSON.stringify({
      webhook_type: "VIRTUAL_ACCOUNT",
      webhook_code: "CONSENT_STATUS_UPDATE",
      consent_id: plaidConsentId,
      new_status: "AUTHORISED",
      event_id: `evt-stale-${b.id}`,
    });
    const result = await processWebhook(env.DB, plaid, body, new Headers(), undefined, KEY);

    expect(result.status).toBe("ignored");
    expect((await getConsent(env.DB, consent.id))?.status).toBe("revoked");
    expect((await getBorrower(env.DB, b.id))?.status).toBe("revoked");
  });
});

describe("raising the automatic retry limit", () => {
  it("does not reach back and collect last quarter's failures", async () => {
    const b = await borrower();
    await setBorrowerStatus(env.DB, b.id, "active");
    const recipient = await addRecipient(env.DB, b.id, {
      name: "Excel Capital",
      accountNumber: await protectString("12345678", KEY),
      sortCode: await protectString("123456", KEY),
    });
    const consent = await createPendingConsent(env.DB, b.id, {
      recipientId: recipient.id,
      currency: "GBP",
      maxPaymentAmountMinor: 100_000,
    });
    await setConsentStatus(env.DB, consent.id, "authorized");

    const old = await insertPayment(env.DB, {
      borrowerId: b.id,
      consentId: consent.id,
      idempotencyKey: `ancient-${b.id}`,
      amountMinor: 20_000,
      currency: "GBP",
      reference: "ExcelOld",
    });
    // Failed six months ago, long since dealt with some other way.
    await env.DB.prepare(
      "UPDATE payments SET status = 'failed', created_at = ?, last_status_at = ? WHERE id = ?",
    )
      .bind("2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", old.id)
      .run();

    const attempted: string[] = [];
    const summary = await runAutoRetries(
      env.DB,
      plaid,
      KEY,
      new Date("2026-08-28T06:00:00Z"),
      async (input) => {
        attempted.push(input.borrowerId);
        return { kind: "collected", payment: { id: "x" } as never, plaidStatus: "PAYMENT_STATUS_INITIATED" };
      },
    );

    expect(attempted).not.toContain(b.id);
    void summary;
  });
});

describe("the daily re-check against the bank", () => {
  it("does not cancel a live mandate over a status it does not recognise", async () => {
    // Everything that was not AUTHORISED used to be read as revoked, so one
    // unfamiliar string — a new value in Plaid's API, a transient state during
    // re-approval — silently cancelled a live mandate and stopped that
    // borrower's collections. Revoked is terminal, so it could not be undone.
    const b = await borrower();
    await setBorrowerStatus(env.DB, b.id, "active");
    const recipient = await addRecipient(env.DB, b.id, {
      name: "Excel Capital",
      accountNumber: await protectString("12345678", KEY),
      sortCode: await protectString("123456", KEY),
    });
    const consent = await createPendingConsent(env.DB, b.id, {
      recipientId: recipient.id,
      currency: "GBP",
      maxPaymentAmountMinor: 50_000,
    });
    const plaidConsentId = `mock-consent-unknown-${b.id}`;
    await env.DB.prepare("UPDATE consents SET plaid_consent_id = ? WHERE id = ?")
      .bind(await encryptString(plaidConsentId, KEY), consent.id)
      .run();
    await setConsentStatus(env.DB, consent.id, "authorized");

    const saying = (status: string) =>
      ({ getConsent: async () => ({ status }) }) as unknown as PlaidClient;

    const summary = await runConsentMaintenance(
      env.DB,
      new Date("2026-08-28T06:00:00Z"),
      undefined,
      saying("SOMETHING_NEW_FROM_PLAID"),
      KEY,
    );

    expect(summary.unknownStatus).toBeGreaterThanOrEqual(1);
    expect((await getConsent(env.DB, consent.id))?.status).toBe("authorized");
    expect((await getBorrower(env.DB, b.id))?.status).toBe("active");
  });

  it("still cancels one the bank really has revoked", async () => {
    const b = await borrower();
    await setBorrowerStatus(env.DB, b.id, "active");
    const recipient = await addRecipient(env.DB, b.id, {
      name: "Excel Capital",
      accountNumber: await protectString("12345678", KEY),
      sortCode: await protectString("123456", KEY),
    });
    const consent = await createPendingConsent(env.DB, b.id, {
      recipientId: recipient.id,
      currency: "GBP",
      maxPaymentAmountMinor: 50_000,
    });
    await env.DB.prepare("UPDATE consents SET plaid_consent_id = ? WHERE id = ?")
      .bind(await encryptString(`mock-consent-rev-${b.id}`, KEY), consent.id)
      .run();
    await setConsentStatus(env.DB, consent.id, "authorized");

    await runConsentMaintenance(
      env.DB,
      new Date("2026-08-28T06:00:00Z"),
      undefined,
      ({ getConsent: async () => ({ status: "REVOKED" }) }) as unknown as PlaidClient,
      KEY,
    );

    expect((await getConsent(env.DB, consent.id))?.status).toBe("revoked");
  });
});

describe("re-consent after a mandate expires", () => {
  it("does not copy the elapsed end date onto the replacement", async () => {
    // The replacement was dead on arrival: the borrower approved it and every
    // collection was then skipped as "consent expired", which is the exact state
    // re-consent exists to get them out of.
    const b = await borrower();
    const recipient = await addRecipient(env.DB, b.id, {
      name: "Excel Capital",
      label: "Main",
      accountNumber: await protectString("12345678", KEY),
      sortCode: await protectString("123456", KEY),
    });
    const consent = await createPendingConsent(env.DB, b.id, {
      recipientId: recipient.id,
      currency: "GBP",
      maxPaymentAmountMinor: 50_000,
      periodicMaxAmountMinor: 200_000,
      period: "MONTH",
      validTo: "2026-01-01T00:00:00.000Z", // already past
    });
    await setConsentStatus(env.DB, consent.id, "expired");

    const step = await provisionLinkToken(env.DB, plaid, KEY, ENV, b.id);

    const replacement = await getConsent(env.DB, step!.consentRowId);
    expect(replacement?.id).not.toBe(consent.id);
    expect(replacement?.valid_to).toBeNull();
    expect(replacement?.max_payment_amount_minor).toBe(50_000);
  });
});
