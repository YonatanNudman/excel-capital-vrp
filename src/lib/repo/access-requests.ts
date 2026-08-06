import type { Role } from "@/lib/types";
import { newId } from "@/lib/ids";
import { createStaff, getStaffByEmail } from "@/lib/repo/staff";

export interface AccessRequest {
  id: string;
  email: string;
  note: string | null;
  status: "pending" | "approved" | "denied";
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  granted_role: Role | null;
}

const normalise = (email: string) => email.trim().toLowerCase();

export async function getRequestByEmail(
  db: D1Database,
  email: string,
): Promise<AccessRequest | null> {
  return db
    .prepare("SELECT * FROM access_requests WHERE email = ?")
    .bind(normalise(email))
    .first<AccessRequest>();
}

export async function getRequest(db: D1Database, id: string): Promise<AccessRequest | null> {
  return db.prepare("SELECT * FROM access_requests WHERE id = ?").bind(id).first<AccessRequest>();
}

/**
 * Record that someone wants access.
 *
 * Deliberately idempotent per email, and deliberately does NOT resurrect a
 * denied request. Anyone can reach the login now, so without both of those a
 * stranger could fill the queue or re-ask forever after being turned down.
 */
export async function requestAccess(
  db: D1Database,
  email: string,
  note: string | null,
): Promise<AccessRequest> {
  const normalised = normalise(email);
  const existing = await getRequestByEmail(db, normalised);
  if (existing) return existing;

  const id = newId();
  await db
    .prepare("INSERT INTO access_requests (id, email, note) VALUES (?, ?, ?)")
    .bind(id, normalised, note?.trim() || null)
    .run();
  const created = await getRequest(db, id);
  if (!created) throw new Error("failed to record access request");
  return created;
}

/** Oldest first, so nobody waits behind a later arrival. */
export async function listPendingRequests(db: D1Database): Promise<AccessRequest[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM access_requests WHERE status = 'pending' ORDER BY requested_at ASC, id ASC",
    )
    .all<AccessRequest>();
  return results ?? [];
}

export async function pendingRequestCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Approve or deny a pending request. Approving creates the staff user with the
 * role the admin chose.
 *
 * The UPDATE is guarded on status = 'pending', so two admins clicking at once
 * cannot both grant access: the second finds nothing to update and is told the
 * request was already decided. A role is required for approval rather than
 * defaulted, because defaulting the permissions on someone's access is exactly
 * the kind of guess that should not be made quietly.
 */
export async function decideRequest(
  db: D1Database,
  opts: { id: string; approve: boolean; role?: Role; decidedBy: string | null },
): Promise<AccessRequest> {
  const request = await getRequest(db, opts.id);
  if (!request) throw new Error("access request not found");
  if (request.status !== "pending") {
    throw new Error("that request was already decided");
  }
  if (opts.approve && !opts.role) {
    throw new Error("choose a role before approving this request");
  }

  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE access_requests
          SET status = ?, decided_at = ?, decided_by = ?, granted_role = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(
      opts.approve ? "approved" : "denied",
      now,
      opts.decidedBy,
      opts.approve ? opts.role! : null,
      opts.id,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new Error("that request was already decided");
  }

  if (opts.approve) {
    // Tolerate the address already existing as staff (added by hand meanwhile).
    const already = await getStaffByEmail(db, request.email);
    if (!already) await createStaff(db, request.email, opts.role!);
  }

  const updated = await getRequest(db, opts.id);
  if (!updated) throw new Error("access request vanished");
  return updated;
}
