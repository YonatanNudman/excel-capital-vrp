import { overdueConsents, consentsExpiringSoon, setConsentStatus } from "@/lib/repo/consents";
import { setBorrowerStatus } from "@/lib/repo/borrowers";
import { writeAudit } from "@/lib/repo/audit";

export interface ConsentMaintenanceSummary {
  expired: number;
  expiringSoon: number;
}

const EXPIRING_SOON_DAYS = 7;

/**
 * Keep consent state honest and give staff early warning:
 *  - consents past their valid_to are marked expired and the borrower flagged
 *    for re-consent (collections will then be blocked by the collect engine).
 *  - consents expiring within the window are audited as "expiring_soon" so a
 *    re-consent can be arranged before a collection fails. (Email wired later.)
 */
export async function runConsentMaintenance(
  db: D1Database,
  now: Date = new Date(),
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
  }

  return { expired: overdue.length, expiringSoon: soon.length };
}
