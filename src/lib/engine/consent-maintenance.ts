import { overdueConsents, consentsExpiringSoon, setConsentStatus } from "@/lib/repo/consents";
import { setBorrowerStatus, getBorrower } from "@/lib/repo/borrowers";
import { writeAudit, listAudit } from "@/lib/repo/audit";
import type { Mailer } from "@/lib/mailer";
import { reconsentEmail } from "@/lib/mailer/templates";

export interface ConsentMaintenanceSummary {
  expired: number;
  expiringSoon: number;
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
): Promise<ConsentMaintenanceSummary> {
  const nowIso = now.toISOString();
  const untilIso = new Date(now.getTime() + EXPIRING_SOON_DAYS * 86_400_000).toISOString();

  const overdue = await overdueConsents(db, nowIso);
  for (const c of overdue) {
    await setConsentStatus(db, c.id, "expired");
    await setBorrowerStatus(db, c.borrower_id, "expired");
    await writeAudit(db, {
      actorStaffId: null,
      action: "consent.expired",
      entityType: "borrower",
      entityId: c.borrower_id,
      metadata: { consentId: c.id, validTo: c.valid_to },
    });
  }

  const soon = await consentsExpiringSoon(db, nowIso, untilIso);
  for (const c of soon) {
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
  }

  return { expired: overdue.length, expiringSoon: soon.length };
}
