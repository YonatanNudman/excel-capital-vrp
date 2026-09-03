import {
  authorisedConsents,
  overdueConsents,
  consentsExpiringSoon,
  pendingConsentsToRecheck,
  setConsentStatus,
} from "@/lib/repo/consents";
import type { PlaidClient } from "@/lib/plaid";
import { confirmConsent } from "@/lib/engine/setup";
import {
  activateBorrowerOnLiveMandate,
  getBorrower,
  syncBorrowerStatusToMandates,
} from "@/lib/repo/borrowers";
import { writeAudit, listAudit } from "@/lib/repo/audit";
import type { Mailer } from "@/lib/mailer";
import { reconsentEmail } from "@/lib/mailer/templates";

/**
 * Provider statuses that genuinely end a mandate. Anything else is unknown, and
 * unknown must never be read as "cancelled".
 */
const TERMINAL_PROVIDER_STATUS: Record<string, "expired" | "revoked"> = {
  EXPIRED: "expired",
  REVOKED: "revoked",
  CANCELLED: "revoked",
  CANCELED: "revoked",
  REJECTED: "revoked",
};

export interface ConsentMaintenanceSummary {
  expired: number;
  expiringSoon: number;
  /** Mandates the borrower cancelled at their bank, found by asking Plaid. */
  revokedAtBank: number;
  /** Mandates the bank described in words we do not recognise. Needs a human. */
  unknownStatus: number;
  /** Mandates the bank had made live while we still showed them as unapproved. */
  authorisedAtBank: number;
}

const EXPIRING_SOON_DAYS = 7;

/**
 * True if a re-consent email has already been audited for this consent. Used to
 * guarantee the borrower is warned at most once per consent, across cron runs.
 */
async function reconsentAlreadySent(db: D1Database, consentId: string): Promise<boolean> {
  const entries = await listAudit(db, { entityType: "consent", entityId: consentId });
  return entries.some((e) => e.action === "email.reconsent");
}

/**
 * Keep consent state honest and give staff early warning:
 *  - consents past their valid_to are marked expired and the borrower flagged
 *    for re-consent (collections will then be blocked by the collect engine).
 *  - consents expiring within the window are audited as "expiring_soon" and the
 *    borrower is emailed a one-time re-consent warning so a new authorisation
 *    can be arranged before a collection fails.
 */
export async function runConsentMaintenance(
  db: D1Database,
  now: Date = new Date(),
  mailer?: Mailer,
  plaid?: PlaidClient,
  encryptionKey?: string,
): Promise<ConsentMaintenanceSummary> {
  const nowIso = now.toISOString();
  const untilIso = new Date(now.getTime() + EXPIRING_SOON_DAYS * 86_400_000).toISOString();

  // Each consent is handled independently: one bad row must never stop the rest
  // of the sweep (the collections that follow depend on this completing).
  const overdue = await overdueConsents(db, nowIso);
  for (const c of overdue) {
    try {
      await setConsentStatus(db, c.id, "expired");
      // Only finish the borrower if this was their LAST live mandate. With more
      // than one payout account, one expiring must not stop the others.
      await syncBorrowerStatusToMandates(db, c.borrower_id, "expired");
      await writeAudit(db, {
        actorStaffId: null,
        action: "consent.expired",
        entityType: "borrower",
        entityId: c.borrower_id,
        metadata: { consentId: c.id, validTo: c.valid_to },
      });
    } catch (e) {
      console.error(`consent maintenance (expire) failed for consent ${c.id}`, e);
    }
  }

  const soon = await consentsExpiringSoon(db, nowIso, untilIso);
  for (const c of soon) {
    try {
      await writeAudit(db, {
        actorStaffId: null,
        action: "consent.expiring_soon",
        entityType: "borrower",
        entityId: c.borrower_id,
        metadata: { consentId: c.id, validTo: c.valid_to },
      });

      // Warn the borrower once per consent, ever. Dedupe on the audit trail so a
      // daily cron does not re-send the same warning every run. Best-effort email.
      if (mailer && !(await reconsentAlreadySent(db, c.id))) {
        const borrower = await getBorrower(db, c.borrower_id);
        if (borrower?.contact_email) {
          const { subject, text } = reconsentEmail({
            borrowerName: borrower.legal_name,
            validTo: c.valid_to ?? "",
          });
          const result = await mailer.send({ to: borrower.contact_email, subject, text });
          await writeAudit(db, {
            actorStaffId: null,
            action: "email.reconsent",
            entityType: "consent",
            entityId: c.id,
            metadata: { mode: mailer.mode, ok: result.ok, to: borrower.contact_email },
          });
        }
      }
    } catch (e) {
      console.error(`consent maintenance (expiring soon) failed for consent ${c.id}`, e);
    }
  }

  // Ask Plaid which mandates are still live.
  //
  // A borrower can cancel a VRP mandate from their banking app at any time,
  // without telling us: that is the deal with VRP, and unlike a Direct Debit the
  // payee cannot stop them. Plaid notifies us, but the authorisation flow already
  // proved that depending on a provider notification arriving is exactly how a
  // real state change gets silently missed.
  //
  // Until this ran, a cancelled mandate stayed "Authorised" on every screen and
  // was only discovered when a collection failed, which is the worst moment and
  // the least clear explanation.
  let revokedAtBank = 0;
  let unknownStatus = 0;
  if (plaid && encryptionKey) {
    for (const consent of await authorisedConsents(db)) {
      let status: string;
      try {
        ({ status } = await confirmConsent(plaid, encryptionKey, consent));
      } catch (error) {
        // A provider blip must never mass-revoke live mandates. Leave it alone
        // and ask again tomorrow.
        console.error("could not re-check consent with Plaid", consent.id, error);
        continue;
      }
      if (status === "AUTHORISED" || status === "AUTHORIZED") continue;

      // Only statuses we actually recognise as the end of a mandate.
      //
      // Anything not AUTHORISED used to be treated as revoked, so one unfamiliar
      // string from Plaid — a status added to their API, a transient
      // AWAITING_AUTHORISATION during re-approval, a typo'd wording change —
      // silently cancelled a live mandate and stopped that borrower's
      // collections. We cannot un-revoke it afterwards either: revoked is
      // terminal. An unknown status is a question for a human, not grounds to
      // stop collecting.
      const mapped = TERMINAL_PROVIDER_STATUS[status.toUpperCase()];
      if (!mapped) {
        console.error("unrecognised consent status from Plaid", consent.id, status);
        await writeAudit(db, {
          actorStaffId: null,
          action: "consent.unknown_provider_status",
          entityType: "consent",
          entityId: consent.id,
          metadata: { borrowerId: consent.borrower_id, providerStatus: status },
        });
        unknownStatus++;
        continue;
      }
      await setConsentStatus(db, consent.id, mapped);
      // Only finish the borrower if this was their LAST live mandate: with more
      // than one account, one cancellation must not stop the others.
      await syncBorrowerStatusToMandates(db, consent.borrower_id, mapped);
      await writeAudit(db, {
        actorStaffId: null,
        action: "consent.revoked_at_bank",
        entityType: "consent",
        entityId: consent.id,
        metadata: { borrowerId: consent.borrower_id, providerStatus: status, mapped },
      });
      revokedAtBank++;
    }
  }

  // The mirror image of the check above: mandates the bank made live without us
  // hearing about it. See reconcileAuthorisedAtBank for why this is not optional.
  const authorisedAtBank =
    plaid && encryptionKey
      ? await reconcileAuthorisedAtBank(db, plaid, encryptionKey, nowIso)
      : 0;

  return {
    expired: overdue.length,
    expiringSoon: soon.length,
    revokedAtBank,
    unknownStatus,
    authorisedAtBank,
  };
}

/**
 * Ask Plaid whether any mandate we show as unapproved is in fact live.
 *
 * Three separate things were supposed to tell us a borrower had approved: Link's
 * success callback, the consent webhook, and a re-check when the borrower reloads
 * their setup page. All three depend on something outside our control happening
 * at the right moment, and the first one has already been observed to fail in
 * production against a real bank: the borrower approved, the return redirect did
 * not complete, and the mandate existed at the bank while every screen here said
 * "not approved yet".
 *
 * The consequence is not cosmetic. That borrower is never collected from, staff
 * chase an authorisation the borrower has already given, and the discrepancy
 * grows quietly for as long as nobody reloads the right page. Asking Plaid every
 * night is the only check that does not depend on someone being present.
 *
 * Deliberately one-directional: it only ever promotes pending to authorised. A
 * mandate that is still genuinely pending, or a Plaid call that fails, is left
 * exactly as it was for tomorrow.
 */
async function reconcileAuthorisedAtBank(
  db: D1Database,
  plaid: PlaidClient,
  encryptionKey: string,
  nowIso: string,
): Promise<number> {
  let found = 0;
  for (const consent of await pendingConsentsToRecheck(db)) {
    let status: string;
    try {
      ({ status } = await confirmConsent(plaid, encryptionKey, consent));
    } catch (error) {
      // A provider blip leaves the mandate pending, which is what we already
      // believed. Nothing to undo; ask again tomorrow.
      console.error("could not re-check pending consent with Plaid", consent.id, error);
      continue;
    }
    if (status !== "AUTHORISED" && status !== "AUTHORIZED") continue;

    // Guarded on status so a webhook that lands mid-sweep cannot be overwritten.
    const updated = await db
      .prepare(
        "UPDATE consents SET status = 'authorized', authorized_at = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(nowIso, consent.id)
      .run();
    if ((updated.meta.changes ?? 0) === 0) continue;

    await activateBorrowerOnLiveMandate(db, consent.borrower_id);
    await writeAudit(db, {
      actorStaffId: null,
      action: "consent.authorized",
      entityType: "borrower",
      entityId: consent.borrower_id,
      metadata: {
        consentId: consent.id,
        recipientId: consent.recipient_id,
        providerStatus: status,
        via: "nightly_recheck",
      },
    });
    found++;
  }
  return found;
}
