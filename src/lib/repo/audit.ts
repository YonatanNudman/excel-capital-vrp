import type { AuditEntry } from "@/lib/types";
import { newId } from "@/lib/ids";

/**
 * Why a borrower could not finish connecting their bank, in the provider's own
 * words. Lives here rather than beside the action that writes it because a
 * "use server" module may export only async functions.
 */
export const SETUP_FAILED_ACTION = "setup.link_failed";

export async function writeAudit(
  db: D1Database,
  entry: {
    actorStaffId: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_staff_id, action, entity_type, entity_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      entry.actorStaffId,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.metadata != null ? JSON.stringify(entry.metadata) : null,
    )
    .run();
}

/** The most recent entry of one action against one entity, or null. */
export async function latestAuditEntry(
  db: D1Database,
  action: string,
  entityType: string,
  entityId: string,
): Promise<AuditEntry | null> {
  return db
    .prepare(
      `SELECT * FROM audit_log
        WHERE action = ? AND entity_type = ? AND entity_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(action, entityType, entityId)
    .first<AuditEntry>();
}

export async function listAudit(
  db: D1Database,
  opts: {
    limit?: number;
    /** Rows to skip, for reading the whole log in pages (the CSV export). */
    offset?: number;
    entityType?: string;
    entityId?: string;
  } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  let sql = "SELECT * FROM audit_log";
  const binds: unknown[] = [];
  if (opts.entityType && opts.entityId) {
    sql += " WHERE entity_type = ? AND entity_id = ?";
    binds.push(opts.entityType, opts.entityId);
  }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  binds.push(limit, Math.max(0, opts.offset ?? 0));
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<AuditEntry>();
  return results ?? [];
}
