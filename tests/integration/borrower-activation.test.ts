import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { reconcilePendingConsents } from "@/lib/engine/setup";
import {
  activateBorrowerOnLiveMandate,
  createBorrower,
  getBorrower,
  setBorrowerStatus,
} from "@/lib/repo/borrowers";
import { addRecipient } from "@/lib/repo/destinations";
import { createPendingConsent, getConsent, setConsentStatus } from "@/lib/repo/consents";
import { encryptString } from "@/lib/crypto";
import type { PlaidClient } from "@/lib/plaid";

const KEY = "test-encryption-key";

let n = 0;

/** A borrower part-way through setup: account and limits saved, awaiting the bank. */
async function seedPending(label = "Main") {
  const b = await createBorrower(env.DB, { legalName: `Activate ${n++} Ltd`, createdBy: null });
  const r = await addRecipient(env.DB, b.id, {
    name: "Payee",
    label,
    accountNumber: "12345678",
    sortCode: "123456",
  });
  const c = await createPendingConsent(env.DB, b.id, {
    recipientId: r.id,
    maxPaymentAmountMinor: 2_000,
    periodicMaxAmountMinor: 60_000,
    period: "MONTH",
  });
  // Real ciphertext: the recheck decrypts this before asking Plaid, so a
  // placeholder would make it skip rather than exercise the path.
  const cipher = await encryptString("plaid-consent-id", KEY);
  await env.DB.prepare("UPDATE consents SET plaid_consent_id = ? WHERE id = ?")
    .bind(cipher, c.id)
    .run();
  return { borrowerId: b.id, consentId: c.id };
}

/** A Plaid stand-in reporting whatever the bank supposedly says about a mandate. */
const plaidSaying = (status: string): PlaidClient =>
  ({ getConsent: async () => ({ status }) }) as unknown as PlaidClient;

/**
 * The bug this exists to prevent: a borrower being collected from every cycle
 * while every screen still reads "Onboarding".
 *
 * borrowers.status was flipped to active in only two of the three places a
 * mandate becomes authorised. The third is the setup page's own recheck against
 * Plaid, which exists BECAUSE the Link callback is so often lost on a phone, and
 * it recorded the authorised mandate without touching the borrower. Nothing
 * downstream noticed: collectPayment skips only paused, revoked and expired, so
 * the money moved and the badge did not.
 */
describe("a borrower whose mandate is confirmed by the setup page recheck", () => {
  it("stops reading onboarding once the bank has approved them", async () => {
    const { borrowerId, consentId } = await seedPending();

    await reconcilePendingConsents(env.DB, plaidSaying("AUTHORISED"), KEY, borrowerId);

    expect((await getConsent(env.DB, consentId))?.status).toBe("authorized");
    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("active");
  });

  it("leaves a borrower the bank has not approved alone", async () => {
    const { borrowerId } = await seedPending();

    await reconcilePendingConsents(env.DB, plaidSaying("AWAITING_AUTHORISATION"), KEY, borrowerId);

    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("onboarding");
  });

  it("never un-pauses a borrower", async () => {
    // Pause is an operator's deliberate decision to stop collecting. An
    // authorisation arriving afterwards must not quietly resume it.
    const { borrowerId } = await seedPending();
    await setBorrowerStatus(env.DB, borrowerId, "paused");

    await reconcilePendingConsents(env.DB, plaidSaying("AUTHORISED"), KEY, borrowerId);

    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("paused");
  });
});

describe("activateBorrowerOnLiveMandate", () => {
  it("refuses to mark a borrower active with no live mandate", async () => {
    // The guard that keeps this from ever claiming money can be taken from
    // someone no bank has approved.
    const { borrowerId } = await seedPending();

    await activateBorrowerOnLiveMandate(env.DB, borrowerId);

    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("onboarding");
  });

  it("clears a stale revoked flag once a fresh mandate is live", async () => {
    // The re-consent path: leaving them revoked would keep collections off
    // forever even though the borrower has approved a new mandate.
    const { borrowerId, consentId } = await seedPending();
    await setBorrowerStatus(env.DB, borrowerId, "revoked");
    await setConsentStatus(env.DB, consentId, "authorized");

    await activateBorrowerOnLiveMandate(env.DB, borrowerId);

    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("active");
  });

  it("is collectable as soon as ONE of several accounts is approved", async () => {
    // The engine will collect against the approved account whether or not a
    // second is outstanding, so the status has to say so. Whether the borrower
    // has finished everything is a separate question, answered by setupProgress.
    const { borrowerId, consentId } = await seedPending("Main");
    const second = await addRecipient(env.DB, borrowerId, {
      name: "Payee 2",
      label: "Backup",
      accountNumber: "87654321",
      sortCode: "654321",
    });
    await createPendingConsent(env.DB, borrowerId, {
      recipientId: second.id,
      maxPaymentAmountMinor: 2_000,
      periodicMaxAmountMinor: 60_000,
      period: "MONTH",
    });
    await setConsentStatus(env.DB, consentId, "authorized");

    await activateBorrowerOnLiveMandate(env.DB, borrowerId);

    expect((await getBorrower(env.DB, borrowerId))?.status).toBe("active");
  });
});
