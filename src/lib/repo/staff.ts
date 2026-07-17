import type { Role, StaffUser } from "@/lib/types";
import { newId } from "@/lib/ids";

export async function getStaffByEmail(
  db: D1Database,
  email: string,
): Promise<StaffUser | null> {
  return db
    .prepare("SELECT * FROM staff_users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<StaffUser>();
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
): Promise<StaffUser> {
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

export async function listStaff(db: D1Database): Promise<StaffUser[]> {
  const { results } = await db
    .prepare("SELECT * FROM staff_users ORDER BY created_at")
    .all<StaffUser>();
  return results ?? [];
}
