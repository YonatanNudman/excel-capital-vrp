import type { Borrower, BorrowerStatus } from "@/lib/types";
import { newId } from "@/lib/ids";

export interface BorrowerListFilter {
  search?: string;
  status?: BorrowerStatus | "all";
}

export async function listBorrowers(
  db: D1Database,
  filter: BorrowerListFilter = {},
): Promise<Borrower[]> {
  let sql = "SELECT * FROM borrowers WHERE deleted_at IS NULL";
  const binds: unknown[] = [];

  if (filter.status && filter.status !== "all") {
    sql += " AND status = ?";
    binds.push(filter.status);
  }
  if (filter.search && filter.search.trim()) {
    const q = `%${filter.search.trim().toLowerCase()}%`;
    sql += " AND (LOWER(legal_name) LIKE ? OR LOWER(company_number) LIKE ?)";
    binds.push(q, q);
  }
  sql += " ORDER BY created_at DESC";

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Borrower>();
  return results ?? [];
}

export async function getBorrower(
  db: D1Database,
  id: string,
): Promise<Borrower | null> {
  return db
    .prepare("SELECT * FROM borrowers WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<Borrower>();
}

/**
 * An existing, non-archived borrower with this company number.
 *
 * Used to refuse a duplicate at creation. Two identical borrowers appeared on
 * production 2.8 seconds apart from one operator pressing Create once, and a
 * duplicate is not harmless here: each carries its own mandate and schedule, so
 * the same company can end up being collected from twice.
 */
export async function findBorrowerByCompanyNumber(
  db: D1Database,
  companyNumber: string,
): Promise<Borrower | null> {
  return db
    .prepare(
      "SELECT * FROM borrowers WHERE company_number = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
    )
    .bind(companyNumber)
    .first<Borrower>();
}

export async function createBorrower(
  db: D1Database,
  data: {
    legalName: string;
    companyNumber?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    registeredAddress?: string | null;
    registeredPostcode?: string | null;
    createdBy: string | null;
  },
): Promise<Borrower> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO borrowers
         (id, legal_name, company_number, contact_email, contact_phone,
          registered_address, registered_postcode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      data.legalName,
      data.companyNumber ?? null,
      data.contactEmail ?? null,
      data.contactPhone ?? null,
      data.registeredAddress ?? null,
      data.registeredPostcode ?? null,
      data.createdBy,
    )
    .run();
  const created = await getBorrower(db, id);
  if (!created) throw new Error("failed to create borrower");
  return created;
}

export async function updateBorrower(
  db: D1Database,
  id: string,
  data: Partial<{
    legalName: string;
    companyNumber: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (data.legalName !== undefined) {
    sets.push("legal_name = ?");
    binds.push(data.legalName);
  }
  if (data.companyNumber !== undefined) {
    sets.push("company_number = ?");
    binds.push(data.companyNumber);
  }
  if (data.contactEmail !== undefined) {
    sets.push("contact_email = ?");
    binds.push(data.contactEmail);
  }
  if (data.contactPhone !== undefined) {
    sets.push("contact_phone = ?");
    binds.push(data.contactPhone);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await db
    .prepare(`UPDATE borrowers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function setBorrowerStatus(
  db: D1Database,
  id: string,
  status: BorrowerStatus,
): Promise<void> {
  await db
    .prepare("UPDATE borrowers SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

/**
 * Archive a borrower: hide them from the list, keep every record.
 *
 * Never a real delete. Payments, consents, schedules and audit rows all point at
 * this row, so removing it would take the payment history with it. A lender has
 * to be able to say what it collected and from whom, years later.
 *
 * Guarded on deleted_at IS NULL so archiving twice cannot overwrite the original
 * archive date, which is the only record of when it happened.
 */
export async function archiveBorrower(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare("UPDATE borrowers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(new Date().toISOString(), id)
    .run();
}

/** Bring an archived borrower back into the list. */
export async function restoreBorrower(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE borrowers SET deleted_at = NULL WHERE id = ?").bind(id).run();
}

/** Archived borrowers, most recently archived first. */
export async function listArchivedBorrowers(db: D1Database): Promise<Borrower[]> {
  const { results } = await db
    .prepare("SELECT * FROM borrowers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
    .all<Borrower>();
  return results ?? [];
}

/** An archived borrower, which getBorrower deliberately will not return. */
export async function getBorrowerIncludingArchived(
  db: D1Database,
  id: string,
): Promise<Borrower | null> {
  return db.prepare("SELECT * FROM borrowers WHERE id = ?").bind(id).first<Borrower>();
}

/**
 * Does this borrower have anything that means archiving them would hide live money?
 *
 * Archiving hides a borrower; it does NOT stop collecting from them. The nightly
 * sweep works from schedules, not from the list, so archiving someone with a live
 * mandate and an active schedule would keep taking their money with nobody
 * watching. Pause is the control that stops collections; these are different
 * things and must stay different.
 */
export async function archiveBlockers(
  db: D1Database,
  id: string,
): Promise<{ activeSchedule: boolean; liveMandate: boolean }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM repayment_schedules
           WHERE borrower_id = ? AND active = 1 AND next_run_date IS NOT NULL) AS sched,
         (SELECT COUNT(*) FROM consents
           WHERE borrower_id = ? AND status = 'authorized') AS mandates`,
    )
    .bind(id, id)
    .first<{ sched: number; mandates: number }>();
  return {
    activeSchedule: (row?.sched ?? 0) > 0,
    liveMandate: (row?.mandates ?? 0) > 0,
  };
}

/**
 * Promote a borrower to active the moment one of their mandates is live.
 *
 * "Onboarding" is meant to say "the borrower cannot be collected from yet", but
 * nothing enforced that: the status was only ever flipped in two of the three
 * places a mandate can become authorised. The Link callback did it, the Plaid
 * webhook did it, and the setup page's own recheck (reconcilePendingConsents,
 * added precisely because the callback often never arrives on a phone) did not.
 * A borrower who finished that way held a live mandate, was collected from every
 * cycle — collectPayment only skips paused, revoked and expired — and still read
 * "Onboarding" on the list. Staff had no way to tell that apart from a borrower
 * who had genuinely done nothing.
 *
 * Written as one statement so the guard cannot be raced by two callers, and
 * deliberately narrow:
 *
 *   - `paused` is untouched. Pause is an operator's decision to stop collecting
 *     and no automatic path may undo it. This is the same rule as
 *     syncBorrowerStatusToMandates, which the webhook previously bypassed with a
 *     bare UPDATE that silently resumed a paused borrower.
 *   - `revoked` and `expired` are cleared, because a fresh mandate after a
 *     re-consent is exactly the case where the old flag is stale.
 *   - It requires a live mandate to exist, so it can never mark a borrower
 *     collectable that no bank has approved.
 */
export async function activateBorrowerOnLiveMandate(
  db: D1Database,
  borrowerId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE borrowers
          SET status = 'active'
        WHERE id = ?
          AND status IN ('onboarding', 'revoked', 'expired')
          AND EXISTS (
            SELECT 1 FROM consents
             WHERE borrower_id = borrowers.id AND status = 'authorized'
          )`,
    )
    .bind(borrowerId)
    .run();
}

/**
 * Set the borrower's status from the mandates they actually still have.
 *
 * Since a borrower can hold several mandates, one per payout account, a single
 * revoked or expired mandate no longer means the borrower is finished. The old
 * code set borrowers.status straight from whichever consent the webhook was
 * about, so revoking a spare account marked the whole borrower revoked, and
 * collectPayment skips a revoked borrower outright. Their perfectly good main
 * mandate would have stopped collecting with nothing on screen to explain it.
 *
 * `whenNoneLeft` is the status to apply only if no live mandate remains.
 *
 * A paused borrower is left alone. Pause is an operator's deliberate decision to
 * stop collecting, and a webhook must never quietly undo it.
 */
export async function syncBorrowerStatusToMandates(
  db: D1Database,
  borrowerId: string,
  whenNoneLeft: "revoked" | "expired",
): Promise<void> {
  const borrower = await getBorrower(db, borrowerId);
  if (!borrower || borrower.status === "paused") return;

  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM consents WHERE borrower_id = ? AND status = 'authorized'")
    .bind(borrowerId)
    .first<{ n: number }>();
  const live = row?.n ?? 0;

  if (live > 0) {
    // Still collectable. Undo a previous revoked/expired flag if one is stale.
    if (borrower.status === "revoked" || borrower.status === "expired") {
      await setBorrowerStatus(db, borrowerId, "active");
    }
    return;
  }
  if (borrower.status !== whenNoneLeft) {
    await setBorrowerStatus(db, borrowerId, whenNoneLeft);
  }
}

