import "server-only";
import { headers } from "next/headers";
import { getDb, getEnv } from "@/lib/db";
import { getAuthenticatedEmail } from "@/lib/access";
import {
  countStaff,
  createStaff,
  getStaffByEmail,
  touchLastLogin,
} from "@/lib/repo/staff";
import type { Role, StaffUser } from "@/lib/types";

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export class AuthError extends Error {
  constructor(
    public code: "unauthenticated" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve the current staff user from the Cloudflare Access identity.
 *
 * Bootstrap rule: if a valid Access identity arrives and the staff table is
 * EMPTY, the first user is provisioned as admin. This is safe because Access
 * already restricts who can reach the app at the edge.
 */
export async function getCurrentUser(): Promise<StaffUser | null> {
  const env = getEnv();
  const db = getDb();
  const h = await headers();
  const email = getAuthenticatedEmail(h, { appEnv: env.APP_ENV ?? "development" });
  if (!email) return null;

  let user = await getStaffByEmail(db, email);
  if (!user) {
    const total = await countStaff(db);
    if (total === 0) {
      user = await createStaff(db, email, "admin");
    } else {
      return null; // authenticated but not authorised
    }
  }
  await touchLastLogin(db, user.id);
  return user;
}

export async function requireUser(): Promise<StaffUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("unauthenticated", "Not signed in or not authorised");
  return user;
}

export function hasRole(user: StaffUser, min: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}

export async function requireRole(min: Role): Promise<StaffUser> {
  const user = await requireUser();
  if (!hasRole(user, min)) {
    throw new AuthError("forbidden", `Requires ${min} role`);
  }
  return user;
}
