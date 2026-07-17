import type { PlaidClient } from "@/lib/plaid";
import { getRecipient, setRecipientPlaidId } from "@/lib/repo/recipients";
import {
  attachPlaidConsent,
  createPendingConsent,
  getActiveConsent,
} from "@/lib/repo/consents";
import { getBorrower } from "@/lib/repo/borrowers";
import { encryptString, decryptString } from "@/lib/crypto";
import type { Consent } from "@/lib/types";

export class SetupError extends Error {}

/**
 * Ensure a borrower has a Plaid recipient and VRP consent provisioned, then mint
 * a FRESH Plaid Link token carrying the consent_id (Link tokens are short-lived,
 * so we always create a new one on each setup-page load).
 *
 * Idempotent: existing Plaid recipient/consent objects are reused. If the latest
 * consent is revoked/expired, a new pending consent is created from its limits
 * (the re-consent path).
 */
export async function provisionLinkToken(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  env: { PLAID_WEBHOOK_URL?: string; APP_BASE_URL?: string },
  borrowerId: string,
): Promise<{ consentRowId: string; linkToken: string; expiration: string }> {
  const borrower = await getBorrower(db, borrowerId);
  if (!borrower) throw new SetupError("borrower not found");

  const recipient = await getRecipient(db, borrowerId);
  if (!recipient) throw new SetupError("no recipient configured for borrower");

  // 1. Plaid recipient
  let plaidRecipientId = recipient.plaid_recipient_id;
  if (!plaidRecipientId) {
    const r = await plaid.createRecipient({
      name: recipient.name,
      accountNumber: recipient.account_number,
      sortCode: recipient.sort_code,
    });
    plaidRecipientId = r.recipientId;
    await setRecipientPlaidId(db, recipient.id, plaidRecipientId);
  }

  // 2. Consent row (re-consent if latest is revoked/expired)
  let consent = await getActiveConsent(db, borrowerId);
  if (!consent) throw new SetupError("no consent limits configured for borrower");
  if (consent.status === "revoked" || consent.status === "expired") {
    consent = await createPendingConsent(db, borrowerId, {
      currency: consent.currency,
      maxPaymentAmountMinor: consent.max_payment_amount_minor,
      period: consent.period,
      periodicAlignment: consent.periodic_alignment,
      periodicMaxAmountMinor: consent.periodic_max_amount_minor,
      validFrom: consent.valid_from,
      validTo: consent.valid_to,
    });
  }

  // 3. Plaid consent
  let plaintextConsentId: string;
  if (consent.plaid_consent_id) {
    plaintextConsentId = await decryptString(consent.plaid_consent_id, encryptionKey);
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

  return { consentRowId: consent.id, linkToken: lt.linkToken, expiration: lt.expiration };
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
  return `Excel-${name}`.replace(/[^a-zA-Z0-9- ]/g, "").slice(0, 18);
}
