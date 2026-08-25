import type { Recipient } from "@/lib/types";
import { newId } from "@/lib/ids";

export async function getRecipient(
  db: D1Database,
  borrowerId: string,
): Promise<Recipient | null> {
  return db
    .prepare("SELECT * FROM recipients WHERE borrower_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(borrowerId)
    .first<Recipient>();
}

/**
 * DANGEROUS with more than one account. Prefer addRecipient / updateRecipient
 * from repo/destinations, which act on a recipient BY ID.
 *
 * This updates the NEWEST recipient row for the borrower. When they had exactly
 * one account that was the same thing as "their account". Now they can have
 * several, and the newest is usually the spare rather than the default, so this
 * silently edits the wrong account. It did exactly that on the borrower edit
 * page, overwriting a backup account's real bank details.
 *
 * The one remaining caller is borrower CREATION, where the borrower provably has
 * no recipients yet, so the upsert can only insert.
 */
export async function upsertRecipient(
  db: D1Database,
  borrowerId: string,
  data: { name: string; accountNumber?: string | null; sortCode?: string | null },
): Promise<Recipient> {
  const existing = await getRecipient(db, borrowerId);
  if (existing) {
    await db
      .prepare("UPDATE recipients SET name = ?, account_number = ?, sort_code = ? WHERE id = ?")
      .bind(data.name, data.accountNumber ?? null, data.sortCode ?? null, existing.id)
      .run();
    return (await getRecipient(db, borrowerId))!;
  }
  const id = newId();
  await db
    .prepare(
      "INSERT INTO recipients (id, borrower_id, name, account_number, sort_code) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, borrowerId, data.name, data.accountNumber ?? null, data.sortCode ?? null)
    .run();
  return (await getRecipient(db, borrowerId))!;
}

export async function setRecipientPlaidId(
  db: D1Database,
  recipientId: string,
  plaidRecipientId: string,
): Promise<void> {
  await db
    .prepare("UPDATE recipients SET plaid_recipient_id = ? WHERE id = ?")
    .bind(plaidRecipientId, recipientId)
    .run();
}
