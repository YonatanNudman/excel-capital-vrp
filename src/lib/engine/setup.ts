import type { PlaidClient } from "@/lib/plaid";
import { setRecipientPlaidId } from "@/lib/repo/recipients";
import { listDestinations } from "@/lib/repo/destinations";
import { destinationLabel } from "@/lib/destinations";
import {
  allPendingConsentsForBorrower,
  attachPlaidConsent,
  createPendingConsent,
  getConsent,
  setConsentPlaidHash,
  setConsentRecipient,
} from "@/lib/repo/consents";
import { activateBorrowerOnLiveMandate, getBorrower } from "@/lib/repo/borrowers";
import { writeAudit } from "@/lib/repo/audit";
import { encryptString, decryptString, sha256Hex, unprotectString } from "@/lib/crypto";
import type { Consent, Recipient } from "@/lib/types";

export class SetupError extends Error {}

export interface SetupStep {
  consentRowId: string;
  linkToken: string;
  expiration: string;
  /** Which account this step approves, for the borrower to recognise. */
  destinationLabel: string;
  /** 1-based position and total, so the borrower knows how many are left. */
  step: number;
  totalSteps: number;
}

/**
 * Provision, and mint a FRESH Plaid Link token for, the NEXT account the borrower
 * still has to approve. Returns null once every account is approved.
 *
 * Deliberately one account at a time rather than all upfront. Link tokens are
 * short-lived, so a token minted for the second account while the borrower is
 * still working through the first would already be dead by the time they reached
 * it. Doing it sequentially also makes the flow resumable: closing the tab and
 * reopening the link picks up at the next unapproved account.
 *
 * Approving several accounts in one sitting is proven to work: two mandates for
 * one borrower at one bank login both reached AUTHORISED, and each collected into
 * its own account.
 *
 * Idempotent: existing Plaid recipient/consent objects are reused. A revoked or
 * expired mandate is replaced by a fresh pending one carrying the same limits
 * (the re-consent path).
 */
export async function provisionLinkToken(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  env: { PLAID_WEBHOOK_URL?: string; APP_BASE_URL?: string },
  borrowerId: string,
): Promise<SetupStep | null> {
  const borrower = await getBorrower(db, borrowerId);
  if (!borrower) throw new SetupError("borrower not found");

  // Unlike collecting, PROVISIONING genuinely needs the account details: Plaid
  // has to be told the sort code and account number to create its recipient. So
  // mandates with no local account row are excluded here, even though they remain
  // collectable once authorised.
  const destinations = (await listDestinations(db, borrowerId))
    .filter((d): d is { recipient: Recipient; consent: typeof d.consent } => d.recipient != null)
    .filter((d) => d.recipient.archived_at == null);
  if (destinations.length === 0) throw new SetupError("no recipient configured for borrower");

  const totalSteps = destinations.length;
  const nextIndex = destinations.findIndex((d) => d.consent?.status !== "authorized");
  if (nextIndex === -1) return null; // every account already approved

  const target = destinations[nextIndex];
  const recipient = target.recipient;

  // 1. Plaid recipient
  let plaidRecipientId = recipient.plaid_recipient_id;
  if (!plaidRecipientId) {
    const r = await plaid.createRecipient({
      name: recipient.name,
      accountNumber: await unprotectString(recipient.account_number, encryptionKey),
      sortCode: await unprotectString(recipient.sort_code, encryptionKey),
    });
    plaidRecipientId = r.recipientId;
    await setRecipientPlaidId(db, recipient.id, plaidRecipientId);
  }

  // 2. Consent row (re-consent if this account's mandate is revoked/expired)
  let consent = target.consent;
  if (!consent) throw new SetupError("no consent limits configured for borrower");
  if (consent.status === "revoked" || consent.status === "expired") {
    const replaced = consent;
    // Carry the end date only if it has not already passed. Copying an elapsed
    // valid_to produced a replacement mandate that was dead on arrival: the
    // borrower approved it at their bank and every collection was then skipped
    // as "consent expired", which is precisely the state re-consent exists to
    // get them out of. Left open-ended instead, still bounded by the per-payment
    // and per-period caps, for an operator to set a new term deliberately.
    const elapsed =
      replaced.valid_to != null && Date.parse(replaced.valid_to) <= Date.now();
    consent = await createPendingConsent(db, borrowerId, {
      recipientId: recipient.id,
      currency: replaced.currency,
      maxPaymentAmountMinor: replaced.max_payment_amount_minor,
      period: replaced.period,
      periodicAlignment: replaced.periodic_alignment,
      periodicMaxAmountMinor: replaced.periodic_max_amount_minor,
      validFrom: replaced.valid_from,
      validTo: elapsed ? null : replaced.valid_to,
    });
    // Carry the schedule to the replacement mandate.
    //
    // A schedule pins the mandate it collects against. Re-consent creates a NEW
    // mandate row, so a schedule left pointing at the revoked one resolved to a
    // revoked mandate on every pass and was skipped, for good: the borrower had
    // re-approved, the money never moved again, and nothing on any screen
    // explained why. Only the schedule that pointed at the mandate being
    // replaced, so an operator's explicit choice of a different account stands.
    await repointSchedulesToReplacementConsent(db, borrowerId, replaced.id, consent.id);
  } else if (!consent.recipient_id) {
    // Legacy row from before mandates recorded their account. Bind it now, so the
    // destination of anything collected against it is knowable.
    await setConsentRecipient(db, consent.id, recipient.id);
  }

  // 3. Plaid consent
  let plaintextConsentId: string;
  if (consent.plaid_consent_id) {
    plaintextConsentId = await decryptString(consent.plaid_consent_id, encryptionKey);
    if (!consent.plaid_consent_id_hash) {
      await setConsentPlaidHash(db, consent.id, await sha256Hex(plaintextConsentId));
    }
  } else {
    const reference = referenceFor(borrower.legal_name);
    const c = await plaid.createConsent(plaidRecipientId, reference, {
      currency: consent.currency,
      maxPaymentAmountMinor: consent.max_payment_amount_minor,
      period: consent.period,
      periodicAlignment: consent.periodic_alignment,
      periodicMaxAmountMinor: consent.periodic_max_amount_minor,
      validFrom: consent.valid_from,
      validTo: consent.valid_to,
    });
    plaintextConsentId = c.consentId;
    // Two overlapping loads of the setup page can each create a consent at Plaid
    // before either records one, and the loser used to overwrite the winner:
    // a live mandate the borrower could approve while we tracked a different id.
    // attachPlaidConsent refuses to overwrite, so a loser re-reads and uses the
    // recorded one instead of orphaning it.
    await attachPlaidConsent(db, consent.id, {
      plaidConsentIdEncrypted: await encryptString(c.consentId, encryptionKey),
      plaidConsentIdHash: await sha256Hex(c.consentId),
      plaidRecipientId,
      rawConstraints: c.rawConstraints,
    });
    const recorded = await getConsent(db, consent.id);
    if (recorded?.plaid_consent_id) {
      const winner = await decryptString(recorded.plaid_consent_id, encryptionKey);
      if (winner !== plaintextConsentId) plaintextConsentId = winner;
    }
  }

  // 4. Fresh Link token
  const lt = await plaid.createLinkToken({
    consentId: plaintextConsentId,
    borrowerId,
    webhookUrl: env.PLAID_WEBHOOK_URL ?? null,
    redirectUri: env.APP_BASE_URL ? `${env.APP_BASE_URL}/setup/complete` : null,
  });

  return {
    consentRowId: consent.id,
    linkToken: lt.linkToken,
    expiration: lt.expiration,
    destinationLabel: destinationLabel(target),
    step: nextIndex + 1,
    totalSteps,
  };
}

/** Confirm authorization with Plaid and return the plaintext consent id + status. */
export async function confirmConsent(
  plaid: PlaidClient,
  encryptionKey: string,
  consent: Consent,
): Promise<{ status: string }> {
  if (!consent.plaid_consent_id) throw new SetupError("consent not provisioned");
  const plaintext = await decryptString(consent.plaid_consent_id, encryptionKey);
  const r = await plaid.getConsent(plaintext);
  return { status: r.status };
}

/** Move any active schedule from a superseded mandate onto its replacement. */
async function repointSchedulesToReplacementConsent(
  db: D1Database,
  borrowerId: string,
  oldConsentId: string,
  newConsentId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE repayment_schedules SET consent_id = ? WHERE borrower_id = ? AND consent_id = ? AND active = 1",
    )
    .bind(newConsentId, borrowerId, oldConsentId)
    .run();
}

function referenceFor(name: string): string {
  return `Excel${name}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
}

/**
 * Ask Plaid which pending mandates are actually authorised, and record them.
 *
 * Plaid is the authority, never the Link callback. On a phone the bank opens in
 * its own tab and Plaid asks the borrower to close it and return to the tab that
 * was waiting; if that tab was closed or the phone suspended it, the result is
 * lost and the borrower is left approved at their bank and pending with us. That
 * happened on production: the bank approved, and nothing was ever recorded.
 *
 * So the setup page runs this on every load. Reopening the link is enough to
 * finish the job, with no dependence on the hand-back working.
 *
 * Returns which mandates it confirmed. Retired accounts are included, because
 * the bank may have made one live while an operator was retiring it, and a live
 * mandate we stopped tracking is worse than an untidy list.
 */
export async function reconcilePendingConsents(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  borrowerId: string,
): Promise<{ confirmedIds: string[] }> {
  const pending = await allPendingConsentsForBorrower(db, borrowerId);
  const confirmedIds: string[] = [];
  const nowIso = new Date().toISOString();

  for (const consent of pending) {
    // Never provisioned with the bank, so there is nothing to confirm yet.
    if (!consent.plaid_consent_id) continue;

    let status: string;
    try {
      ({ status } = await confirmConsent(plaid, encryptionKey, consent));
    } catch (error) {
      // A provider blip must not stop the borrower seeing their page. Leave the
      // mandate pending; the next load asks again.
      console.error("could not confirm consent with Plaid", consent.id, error);
      continue;
    }
    if (status !== "AUTHORISED" && status !== "AUTHORIZED") continue;

    await db
      .prepare(
        "UPDATE consents SET status = 'authorized', authorized_at = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(nowIso, consent.id)
      .run();
    await writeAudit(db, {
      actorStaffId: null,
      action: "consent.authorized",
      entityType: "borrower",
      entityId: borrowerId,
      metadata: { consentId: consent.id, recipientId: consent.recipient_id, via: "setup_page_recheck" },
    });
    confirmedIds.push(consent.id);
  }

  // The status has to move here too, not only in the Link callback. This path
  // exists BECAUSE the callback is unreliable on a phone, so leaving the flip to
  // the callback left borrowers with a live mandate reading "Onboarding" forever
  // while being collected from every cycle.
  if (confirmedIds.length > 0) {
    await activateBorrowerOnLiveMandate(db, borrowerId);
  }

  return { confirmedIds };
}
