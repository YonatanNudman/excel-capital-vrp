import type { SetupLink } from "@/lib/types";
import { newId } from "@/lib/ids";

export async function insertSetupLink(
  db: D1Database,
  data: {
    borrowerId: string;
    tokenHash: string;
    expiresAt: string;
    createdBy: string | null;
  },
): Promise<SetupLink> {
  const id = newId();
  await db
    .prepare(
      "INSERT INTO setup_links (id, borrower_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, data.borrowerId, data.tokenHash, data.expiresAt, data.createdBy)
    .run();
  return (await db
    .prepare("SELECT * FROM setup_links WHERE id = ?")
    .bind(id)
    .first<SetupLink>())!;
}

/**
 * Look up a live (unused) setup link by token hash. Used links, whether
 * consumed on completion or invalidated when a newer link was issued, are
 * excluded, enforcing single-use and revocation.
 */
export async function getSetupLinkByHash(
  db: D1Database,
  tokenHash: string,
): Promise<SetupLink | null> {
  return db
    .prepare("SELECT * FROM setup_links WHERE token_hash = ? AND used_at IS NULL")
    .bind(tokenHash)
    .first<SetupLink>();
}

export async function markSetupLinkUsed(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE setup_links SET used_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

/** Invalidate any outstanding (unused) links for a borrower, e.g. before issuing a new one. */
export async function invalidateBorrowerLinks(
  db: D1Database,
  borrowerId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE setup_links SET used_at = ? WHERE borrower_id = ? AND used_at IS NULL",
    )
    .bind(new Date().toISOString(), borrowerId)
    .run();
}

/**
 * The most recent link issued to a borrower, whatever its state.
 *
 * Staff need to tell "they are ignoring me" from "the link expired", and neither
 * is visible if only live links can be looked up.
 */
export async function latestSetupLinkForBorrower(
  db: D1Database,
  borrowerId: string,
): Promise<SetupLink | null> {
  return db
    .prepare(
      "SELECT * FROM setup_links WHERE borrower_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(borrowerId)
    .first<SetupLink>();
}
