import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";
import { createBorrower, getBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import { addRecipient } from "@/lib/repo/destinations";
import { createPendingConsent, getConsent } from "@/lib/repo/consents";
import type { PlaidClient } from "@/lib/plaid";
import { encryptString } from "@/lib/crypto";

const KEY = "test-encryption-key";

let n = 0;

/**
 * A borrower part-way through setup: the mandate exists at Plaid, and as far as
 * this system knows the borrower has not approved it yet.
 *
 * `provisioned: false` is the other real shape, an abandoned attempt where Link
 * never reached the bank, so there is no provider id to ask about.
 */
async function seedPending({ provisioned = true } = {}) {
  const b = await createBorrower(env.DB, { legalName: `Silent ${n++} Ltd`, createdBy: null });
  const r = await addRecipient(env.DB, b.id, {
    name: "Payee",
    accountNumber: "12345678",
    sortCode: "123456",
  });
  const c = await createPendingConsent(env.DB, b.id, {
    recipientId: r.id,
    maxPaymentAmountMinor: 2_000,
    periodicMaxAmountMinor: 60_000,
    period: "MONTH",
  });
  if (provisioned) {
    // Real ciphertext: the re-check decrypts this before calling Plaid, so a
    // placeholder would make the call fail rather than exercise the path.
    const cipher = await encryptString("plaid-consent-id", KEY);
    await env.DB.prepare("UPDATE consents SET plaid_consent_id = ? WHERE id = ?")
      .bind(cipher, c.id)
      .run();
  }
  return { borrowerId: b.id, consentId: c.id };
}

const plaidSaying = (status: string): PlaidClient =>
  ({ getConsent: async () => ({ status }) }) as unknown as PlaidClient;

const plaidFailing = (): PlaidClient =>
  ({
    getConsent: async () => {
      throw new Error("provider unavailable");
    },
  }) as unknown as PlaidClient;

/**
 * The mirror of a mandate cancelled at the bank, and the one that costs money.
 *
 * Observed in production against a real bank: the borrower approved, the return
 * redirect did not complete, and the mandate was live at the bank while every
 * screen here said "not approved yet". Nothing collects from that borrower, and
 * staff chase an authorisation that has already been given.
 */
describe("a mandate approved at the bank that we never heard about", () => {
  it("is found by asking Plaid, with no callback and no webhook", async () => {
    const { consentId } = await seedPending();
    const summary = await runConsentMaintenance(
      env.DB,
      new Date(),
      undefined,
      plaidSaying("AUTHORISED"),
      KEY,
    );
    expect(summary.authorisedAtBank).toBeGreaterThanOrEqual(1);
    expect((await getConsent(env.DB, consentId))?.status).toBe("authorized");
  });

  it("makes the borrower collectable", async () => {
    const { borrowerId } = await seedPending();
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("AUTHORISED"), KEY);
    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("active");
  });

  it("stamps authorized_at so the mandate is not treated as approved at time zero", async () => {
    const { consentId } = await seedPending();
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("AUTHORISED"), KEY);
    expect((await getConsent(env.DB, consentId))?.authorized_at).toBeTruthy();
  });

  it("leaves a borrower staff have paused paused", async () => {
    // Pausing is an instruction to stop collecting. A mandate turning out to be
    // live is not the staff member withdrawing it, and resuming collections
    // here would take money someone had deliberately stopped.
    const { borrowerId, consentId } = await seedPending();
    await setBorrowerStatus(env.DB, borrowerId, "paused");
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("AUTHORISED"), KEY);
    expect((await getConsent(env.DB, consentId))?.status).toBe("authorized");
    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("paused");
  });

  it("leaves a mandate the borrower genuinely has not approved alone", async () => {
    const { borrowerId, consentId } = await seedPending();
    const summary = await runConsentMaintenance(
      env.DB,
      new Date(),
      undefined,
      plaidSaying("AWAITING_AUTHORISATION"),
      KEY,
    );
    expect(summary.authorisedAtBank).toBe(0);
    expect((await getConsent(env.DB, consentId))?.status).toBe("pending");
    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("onboarding");
  });

  it("never promotes a mandate because the provider call failed", async () => {
    // The failure mode that would matter: treating "we could not ask" as "yes"
    // would mark a borrower collectable on no evidence at all.
    const { consentId } = await seedPending();
    const summary = await runConsentMaintenance(env.DB, new Date(), undefined, plaidFailing(), KEY);
    expect(summary.authorisedAtBank).toBe(0);
    expect((await getConsent(env.DB, consentId))?.status).toBe("pending");
  });

  it("ignores an abandoned attempt that never reached the bank", async () => {
    // No provider id means there is nothing to ask about. Asking anyway would
    // throw on every sweep for every abandoned setup link.
    const { consentId } = await seedPending({ provisioned: false });
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("AUTHORISED"), KEY);
    expect((await getConsent(env.DB, consentId))?.status).toBe("pending");
  });
});
