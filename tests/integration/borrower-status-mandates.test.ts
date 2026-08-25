import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  createBorrower,
  getBorrower,
  setBorrowerStatus,
  syncBorrowerStatusToMandates,
} from "@/lib/repo/borrowers";
import { addRecipient } from "@/lib/repo/destinations";
import { createPendingConsent, setConsentStatus } from "@/lib/repo/consents";

let n = 0;
const borrower = () =>
  createBorrower(env.DB, { legalName: `Status ${n++} Ltd`, createdBy: null });

async function mandate(borrowerId: string, label: string, authorised = true) {
  const r = await addRecipient(env.DB, borrowerId, { name: label, label });
  const c = await createPendingConsent(env.DB, borrowerId, {
    recipientId: r.id,
    maxPaymentAmountMinor: 10_000,
    periodicMaxAmountMinor: 50_000,
    period: "MONTH",
  });
  if (authorised) await setConsentStatus(env.DB, c.id, "authorized");
  return c;
}

describe("borrower status follows the mandates that remain", () => {
  /**
   * The bug this exists to prevent. A borrower with two payout accounts revokes
   * the spare one. The old code set borrowers.status straight from whichever
   * consent the webhook was about, and collectPayment skips a revoked borrower
   * outright, so their perfectly good main mandate stopped collecting with
   * nothing on screen to explain it.
   */
  it("stays active when one of two mandates is revoked", async () => {
    const b = await borrower();
    await mandate(b.id, "Main");
    const spare = await mandate(b.id, "Spare");
    await setBorrowerStatus(env.DB, b.id, "active");

    await setConsentStatus(env.DB, spare.id, "revoked");
    await syncBorrowerStatusToMandates(env.DB, b.id, "revoked");

    expect((await getBorrower(env.DB, b.id))!.status).toBe("active");
  });

  it("is revoked once the last mandate goes", async () => {
    const b = await borrower();
    const only = await mandate(b.id, "Only");
    await setBorrowerStatus(env.DB, b.id, "active");

    await setConsentStatus(env.DB, only.id, "revoked");
    await syncBorrowerStatusToMandates(env.DB, b.id, "revoked");

    expect((await getBorrower(env.DB, b.id))!.status).toBe("revoked");
  });

  it("expires only when nothing live is left", async () => {
    const b = await borrower();
    await mandate(b.id, "Main");
    const spare = await mandate(b.id, "Spare");
    await setBorrowerStatus(env.DB, b.id, "active");

    await setConsentStatus(env.DB, spare.id, "expired");
    await syncBorrowerStatusToMandates(env.DB, b.id, "expired");
    expect((await getBorrower(env.DB, b.id))!.status).toBe("active");
  });

  it("never un-pauses a borrower", async () => {
    // Pause is an operator's deliberate decision to stop collecting. A webhook
    // arriving afterwards must not quietly undo it.
    const b = await borrower();
    await mandate(b.id, "Main");
    await setBorrowerStatus(env.DB, b.id, "paused");

    await syncBorrowerStatusToMandates(env.DB, b.id, "revoked");
    expect((await getBorrower(env.DB, b.id))!.status).toBe("paused");
  });

  it("clears a stale revoked flag once a mandate is live again", async () => {
    // The re-consent path: the borrower was revoked, then authorised a new
    // mandate. Leaving them revoked would keep collections off forever.
    const b = await borrower();
    await setBorrowerStatus(env.DB, b.id, "revoked");
    await mandate(b.id, "Fresh");

    await syncBorrowerStatusToMandates(env.DB, b.id, "revoked");
    expect((await getBorrower(env.DB, b.id))!.status).toBe("active");
  });

  it("leaves a borrower with no mandates at all alone if already correct", async () => {
    const b = await borrower();
    await setBorrowerStatus(env.DB, b.id, "revoked");
    await syncBorrowerStatusToMandates(env.DB, b.id, "revoked");
    expect((await getBorrower(env.DB, b.id))!.status).toBe("revoked");
  });
});
