import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { runConsentMaintenance } from "@/lib/engine/consent-maintenance";
import { createBorrower, getBorrower } from "@/lib/repo/borrowers";
import { addRecipient } from "@/lib/repo/destinations";
import { createPendingConsent, getConsent, setConsentStatus } from "@/lib/repo/consents";
import type { PlaidClient } from "@/lib/plaid";
import { encryptString } from "@/lib/crypto";

const KEY = "test-encryption-key";

let n = 0;

/** A borrower with one live mandate, as production looks after a real approval. */
async function seedLive(status: "authorized" = "authorized") {
  const b = await createBorrower(env.DB, { legalName: `Cancel ${n++} Ltd`, createdBy: null });
  const r = await addRecipient(env.DB, b.id, { name: "Payee", accountNumber: "12345678", sortCode: "123456" });
  const c = await createPendingConsent(env.DB, b.id, {
    recipientId: r.id,
    maxPaymentAmountMinor: 2_000,
    periodicMaxAmountMinor: 60_000,
    period: "MONTH",
  });
  // Real ciphertext: confirmConsent decrypts this before calling Plaid, so a
  // placeholder makes the re-check fail rather than exercise it.
  const cipher = await encryptString("plaid-consent-id", KEY);
  await env.DB.prepare("UPDATE consents SET plaid_consent_id = ? WHERE id = ?").bind(cipher, c.id).run();
  await setConsentStatus(env.DB, c.id, status);
  return { borrowerId: b.id, consentId: c.id };
}

/** A Plaid stand-in that reports whatever the bank supposedly says. */
const plaidSaying = (status: string): PlaidClient =>
  ({ getConsent: async () => ({ status }) }) as unknown as PlaidClient;

/**
 * A borrower can cancel a VRP mandate from their banking app at any time, and
 * unlike a Direct Debit the payee cannot prevent it. Plaid notifies us, but the
 * authorisation flow already proved that depending on a provider notification
 * arriving is exactly how a real state change gets silently missed.
 *
 * Until this ran, a cancelled mandate stayed "Authorised" on every screen and was
 * only discovered when a collection failed.
 */
describe("a mandate cancelled at the bank", () => {
  it("is found by asking Plaid, without any notification", async () => {
    const { consentId } = await seedLive();
    const summary = await runConsentMaintenance(
      env.DB,
      new Date(),
      undefined,
      plaidSaying("REVOKED"),
      KEY,
    );
    expect(summary.revokedAtBank).toBeGreaterThanOrEqual(1);
    expect((await getConsent(env.DB, consentId))?.status).toBe("revoked");
  });

  it("stops the borrower being collectable once their last mandate is gone", async () => {
    const { borrowerId } = await seedLive();
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("REVOKED"), KEY);
    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("revoked");
  });

  it("records an expired mandate as expired, not revoked", async () => {
    // Different causes, and staff respond to them differently: one is the
    // borrower changing their mind, the other is time running out.
    const { consentId } = await seedLive();
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("EXPIRED"), KEY);
    expect((await getConsent(env.DB, consentId))?.status).toBe("expired");
  });

  it("leaves a live mandate alone", async () => {
    const { consentId } = await seedLive();
    await runConsentMaintenance(env.DB, new Date(), undefined, plaidSaying("AUTHORISED"), KEY);
    expect((await getConsent(env.DB, consentId))?.status).toBe("authorized");
  });

  it("never mass-revokes when Plaid itself is failing", async () => {
    // The dangerous failure: a provider outage must not look like every borrower
    // cancelling at once.
    const { consentId } = await seedLive();
    const brokenPlaid = {
      getConsent: async () => {
        throw new Error("provider down");
      },
    } as unknown as PlaidClient;
    await runConsentMaintenance(env.DB, new Date(), undefined, brokenPlaid, KEY);
    expect((await getConsent(env.DB, consentId))?.status).toBe("authorized");
  });

  it("does nothing when no Plaid client is supplied", async () => {
    const { consentId } = await seedLive();
    const summary = await runConsentMaintenance(env.DB, new Date());
    expect(summary.revokedAtBank).toBe(0);
    expect((await getConsent(env.DB, consentId))?.status).toBe("authorized");
  });
});
