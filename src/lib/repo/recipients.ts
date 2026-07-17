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
