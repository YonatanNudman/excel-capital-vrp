import type { PlaidClient } from "@/lib/plaid";
import { setRecipientPlaidId } from "@/lib/repo/recipients";
import { listDestinations } from "@/lib/repo/destinations";
import { destinationLabel } from "@/lib/destinations";
import {
  attachPlaidConsent,
  createPendingConsent,
  setConsentPlaidHash,
  setConsentRecipient,
} from "@/lib/repo/consents";
import { getBorrower } from "@/lib/repo/borrowers";
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
    consent = await createPendingConsent(db, borrowerId, {
      recipientId: recipient.id,
      currency: consent.currency,
      maxPaymentAmountMinor: consent.max_payment_amount_minor,
      period: consent.period,
      periodicAlignment: consent.periodic_alignment,
      periodicMaxAmountMinor: consent.periodic_max_amount_minor,
      validFrom: consent.valid_from,
      validTo: consent.valid_to,
    });
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
    await attachPlaidConsent(db, consent.id, {
      plaidConsentIdEncrypted: await encryptString(c.consentId, encryptionKey),
      plaidConsentIdHash: await sha256Hex(c.consentId),
      plaidRecipientId,
      rawConstraints: c.rawConstraints,
    });
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

function referenceFor(name: string): string {
  return `Excel${name}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
}
