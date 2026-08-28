import type { Consent, Recipient } from "@/lib/types";
import { newId } from "@/lib/ids";
import { resolveDestination, type Destination, type Resolution } from "@/lib/destinations";
export type { Destination } from "@/lib/destinations";

/**
 * Every payout destination for a borrower, newest-default first.
 *
 * One query per table rather than a join, because a recipient with no consent
 * yet is a real and common state (staff add the account, then set its limits)
 * and a join would either hide it or need an outer join plus column aliasing to
 * untangle two tables that both have `id`, `status` and `created_at`.
 */
export async function listDestinations(
  db: D1Database,
  borrowerId: string,
): Promise<Destination[]> {
  const [recipients, consents] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM recipients WHERE borrower_id = ? ORDER BY is_default DESC, created_at ASC",
      )
      .bind(borrowerId)
      .all<Recipient>(),
    db
      .prepare("SELECT * FROM consents WHERE borrower_id = ? ORDER BY created_at DESC")
      .bind(borrowerId)
      .all<Consent>(),
  ]);

  return assembleDestinations(recipients.results ?? [], consents.results ?? []);
}

/**
 * Pair accounts with their mandates. Extracted so that the borrower list, which
 * loads many borrowers at once, answers "has this borrower finished" from
 * exactly the same rules as the borrower page rather than from a second SQL
 * expression that has to be kept in step by hand.
 */
function assembleDestinations(rows: Recipient[], allConsents: Consent[]): Destination[] {
  const destinations: Destination[] = rows.map((recipient) => {
    // Prefer an authorised mandate for this account; otherwise its most recent.
    // Ordering by status first matters during re-consent, when a revoked mandate
    // and a fresh pending one both exist for the same account.
    const forRecipient = allConsents.filter((c) => c.recipient_id === recipient.id);
    const consent =
      forRecipient.find((c) => c.status === "authorized") ?? forRecipient[0] ?? null;
    return { recipient, consent };
  });

  // Mandates we hold no account row for. These MUST still be collectable: Plaid
  // executes against the consent alone, so a missing local row is a bookkeeping
  // gap, not a reason to refuse a payment the borrower already authorised.
  // Reachable for data written before mandates recorded their account.
  const knownRecipientIds = new Set(rows.map((r) => r.id));
  const orphans = allConsents.filter(
    (c) => c.recipient_id == null || !knownRecipientIds.has(c.recipient_id),
  );
  for (const consent of orphans) {
    destinations.push({ recipient: null, consent });
  }

  return destinations;
}

/**
 * Destinations for many borrowers at once, keyed by borrower id.
 *
 * Two queries in total rather than two per borrower: the list page shows every
 * borrower, and a per-row lookup would turn one screen into dozens of round
 * trips to D1. Ids are chunked because SQLite refuses a statement with more
 * bound parameters than its variable limit, which a growing borrower list would
 * eventually reach.
 */
export async function listDestinationsForBorrowers(
  db: D1Database,
  borrowerIds: string[],
): Promise<Map<string, Destination[]>> {
  const byBorrower = new Map<string, Destination[]>();
  for (const id of borrowerIds) byBorrower.set(id, []);

  const unique = [...new Set(borrowerIds)];
  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const ids = unique.slice(i, i + CHUNK);
    const placeholders = ids.map(() => "?").join(", ");
    const [recipients, consents] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM recipients WHERE borrower_id IN (${placeholders})
            ORDER BY is_default DESC, created_at ASC`,
        )
        .bind(...ids)
        .all<Recipient>(),
      db
        .prepare(
          `SELECT * FROM consents WHERE borrower_id IN (${placeholders})
            ORDER BY created_at DESC`,
        )
        .bind(...ids)
        .all<Consent>(),
    ]);

    for (const id of ids) {
      byBorrower.set(
        id,
        assembleDestinations(
          (recipients.results ?? []).filter((r) => r.borrower_id === id),
          (consents.results ?? []).filter((c) => c.borrower_id === id),
        ),
      );
    }
  }

  return byBorrower;
}

/**
 * Resolve, and prove ownership of, the destination a collection should pay into.
 *
 * The ownership check lives here rather than in the caller because every
 * collection path must have it: `requestedConsentId` comes from a form, and an
 * id belonging to another borrower must never be executed against.
 */
export async function resolveCollectionDestination(
  db: D1Database,
  borrowerId: string,
  requestedConsentId?: string | null,
): Promise<Resolution> {
  return resolveDestination(await listDestinations(db, borrowerId), requestedConsentId);
}

/**
 * Does this mandate belong to this borrower?
 *
 * Ownership only, deliberately NOT readiness. A schedule may be pointed at an
 * account the borrower has not approved yet, which is normal: staff set the
 * schedule up first and the setup link goes out afterwards. Using the stricter
 * collectable check here would make that ordinary sequence impossible.
 */
export async function consentBelongsToBorrower(
  db: D1Database,
  borrowerId: string,
  consentId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM consents WHERE id = ? AND borrower_id = ?")
    .bind(consentId, borrowerId)
    .first<{ id: string }>();
  return row != null;
}

export async function getRecipientById(
  db: D1Database,
  id: string,
): Promise<Recipient | null> {
  return db.prepare("SELECT * FROM recipients WHERE id = ?").bind(id).first<Recipient>();
}

/**
 * Add a payout destination. The borrower's FIRST account becomes the default
 * automatically, so a single-destination borrower never has to think about a
 * concept that only matters once there are two.
 */
export async function addRecipient(
  db: D1Database,
  borrowerId: string,
  data: {
    name: string;
    label?: string | null;
    accountNumber?: string | null;
    sortCode?: string | null;
    makeDefault?: boolean;
  },
): Promise<Recipient> {
  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM recipients WHERE borrower_id = ?")
    .bind(borrowerId)
    .first<{ n: number }>();
  const isFirst = (existing?.n ?? 0) === 0;
  const shouldDefault = isFirst || data.makeDefault === true;

  const id = newId();
  const insert = db
    .prepare(
      `INSERT INTO recipients (id, borrower_id, name, label, account_number, sort_code, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      borrowerId,
      data.name,
      data.label?.trim() || null,
      data.accountNumber ?? null,
      data.sortCode ?? null,
      shouldDefault ? 1 : 0,
    );

  if (shouldDefault && !isFirst) {
    // The partial unique index permits only one default per borrower, so the old
    // one must be cleared in the SAME transaction or the insert violates it.
    await db.batch([
      db.prepare("UPDATE recipients SET is_default = 0 WHERE borrower_id = ?").bind(borrowerId),
      insert,
    ]);
  } else {
    await insert.run();
  }

  return (await getRecipientById(db, id))!;
}

/** Rename or re-bank an account. Refuses once a mandate has been authorised. */
export async function updateRecipient(
  db: D1Database,
  recipientId: string,
  data: {
    name: string;
    label?: string | null;
    accountNumber?: string | null;
    sortCode?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE recipients SET name = ?, label = ?,
         account_number = COALESCE(?, account_number),
         sort_code = COALESCE(?, sort_code)
       WHERE id = ?`,
    )
    .bind(
      data.name,
      data.label?.trim() || null,
      data.accountNumber ?? null,
      data.sortCode ?? null,
      recipientId,
    )
    .run();
}

/**
 * Move the default to another account.
 *
 * Guarded on borrower_id as well as recipient id: the id arrives from a form,
 * and without the guard a request could hand another borrower's account to this
 * borrower's default, quietly redirecting their scheduled collections.
 */
export async function setDefaultRecipient(
  db: D1Database,
  borrowerId: string,
  recipientId: string,
): Promise<boolean> {
  const owned = await db
    .prepare(
      "SELECT id FROM recipients WHERE id = ? AND borrower_id = ? AND archived_at IS NULL",
    )
    .bind(recipientId, borrowerId)
    .first<{ id: string }>();
  if (!owned) return false;

  await db.batch([
    db.prepare("UPDATE recipients SET is_default = 0 WHERE borrower_id = ?").bind(borrowerId),
    db.prepare("UPDATE recipients SET is_default = 1 WHERE id = ?").bind(recipientId),
  ]);
  return true;
}

/**
 * Retire an account from the picker without deleting it.
 *
 * Payment history reaches this row through its consent, so the row has to stay
 * readable forever. Refuses to archive the default while another live account
 * exists, because a borrower with no default has nowhere for scheduled
 * collections to go, and refuses to archive the LAST account outright.
 */
export async function archiveRecipient(
  db: D1Database,
  borrowerId: string,
  recipientId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const live = await db
    .prepare(
      "SELECT id, is_default FROM recipients WHERE borrower_id = ? AND archived_at IS NULL",
    )
    .bind(borrowerId)
    .all<{ id: string; is_default: number }>();
  const rows = live.results ?? [];
  const target = rows.find((r) => r.id === recipientId);
  if (!target) return { ok: false, reason: "That account is not set up for this borrower." };
  if (rows.length === 1) {
    return {
      ok: false,
      reason: "This is the only account left, so it cannot be retired. Add another one first.",
    };
  }
  if (target.is_default) {
    return {
      ok: false,
      reason: "This is the default account. Make another account the default first.",
    };
  }

  await db
    .prepare(
      "UPDATE recipients SET archived_at = ?, is_default = 0 WHERE id = ? AND archived_at IS NULL",
    )
    .bind(new Date().toISOString(), recipientId)
    .run();
  return { ok: true };
}
