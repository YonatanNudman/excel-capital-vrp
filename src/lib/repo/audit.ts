import type { AuditEntry } from "@/lib/types";
import { newId } from "@/lib/ids";

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

export async function listAudit(
  db: D1Database,
  opts: { limit?: number; entityType?: string; entityId?: string } = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  let sql = "SELECT * FROM audit_log";
  const binds: unknown[] = [];
  if (opts.entityType && opts.entityId) {
    sql += " WHERE entity_type = ? AND entity_id = ?";
    binds.push(opts.entityType, opts.entityId);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<AuditEntry>();
  return results ?? [];
}
