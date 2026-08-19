import type { Role, StaffUser } from "@/lib/types";
import { newId } from "@/lib/ids";

// The staff_users row after migration 0002 carries a soft-disable flag. The
// shared StaffUser type does not model it, so repo reads use this widened row
// (assignable anywhere StaffUser is expected) to expose disabled_at.
export type StaffRow = StaffUser & { disabled_at: string | null };

export async function getStaffByEmail(
  db: D1Database,
  email: string,
): Promise<StaffRow | null> {
  return db
    .prepare("SELECT * FROM staff_users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<StaffRow>();
}

export async function getStaffById(
  db: D1Database,
  id: string,
): Promise<StaffRow | null> {
  return db
    .prepare("SELECT * FROM staff_users WHERE id = ?")
    .bind(id)
    .first<StaffRow>();
}

export async function listStaff(
  db: D1Database,
): Promise<StaffRow[]> {
  let sql = "SELECT * FROM staff_users ORDER BY created_at DESC";

  return db
    .prepare(sql)
    .all<StaffRow>();
}

export async function countStaff(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM staff_users")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createStaff(
  db: D1Database,
  email: string,
  role: Role,
): Promise<StaffRow> {
  const id = newId();
  await db
    .prepare("INSERT INTO staff_users (id, email, role) VALUES (?, ?, ?)")
    .bind(id, email.toLowerCase(), role)
    .run();
  const created = await getStaffByEmail(db, email);
  if (!created) throw new Error("failed to create staff user");
  return created;
}

export async function touchLastLogin(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET last_login_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

export async function listStaff(db: D1Database): Promise<StaffRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM staff_users ORDER BY created_at")
    .all<StaffRow>();
  return results ?? [];
}

export async function setStaffRole(
  db: D1Database,
  id: string,
  role: Role,
): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET role = ? WHERE id = ?")
    .bind(role, id)
    .run();
}

/** Set disabled_at to now (disable) or NULL (enable). */
export async function setStaffDisabled(
  db: D1Database,
  id: string,
  disabled: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET disabled_at = ? WHERE id = ?")
    .bind(disabled ? new Date().toISOString() : null, id)
    .run();
}

export async function countActiveAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin' AND disabled_at IS NULL",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Decide whether a staff change is allowed. Returns a human-readable reason
 * when the change must be blocked, or null when it is allowed.
 *
 * Rules:
 *  - The target must exist.
 *  - An actor may not disable themselves or demote themselves from admin.
 *  - Demoting or disabling the last active admin is blocked.
 */
export async function staffChangeGuard(
  db: D1Database,
  actorId: string,
  targetId: string,
  change: { role?: Role; disable?: boolean },
): Promise<string | null> {
  const target = await getStaffById(db, targetId);
  if (!target) return "Staff member not found";

  const isSelf = actorId === targetId;
  const targetIsAdmin = target.role === "admin";
  const targetIsActive = target.disabled_at == null;
  const demotesFromAdmin =
    change.role !== undefined && change.role !== "admin" && targetIsAdmin;
  const disables = change.disable === true;

  // An actor cannot lock themselves out.
  if (isSelf && (disables || demotesFromAdmin)) {
    return "You cannot remove your own admin access";
  }

  // Never leave the platform with zero active admins.
  if (targetIsAdmin && targetIsActive && (demotesFromAdmin || disables)) {
    if ((await countActiveAdmins(db)) <= 1) {
      return "At least one active admin is required";
    }
  }

  return null;
}
