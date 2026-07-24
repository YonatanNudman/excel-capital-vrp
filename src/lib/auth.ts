import "server-only";
import { headers } from "next/headers";
import { getDb, getEnv } from "@/lib/db";
import { getAuthenticatedEmail } from "@/lib/access";
import {
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
 * Resolve the current staff user from the (verified) Cloudflare Access identity.
 *
 * Bootstrap rule: an authenticated email is auto-provisioned as admin ONLY if it
 * appears in the STAFF_BOOTSTRAP_ADMINS allowlist (comma-separated). Without the
 * allowlist there is no auto-provisioning, staff must be seeded explicitly.
 * This removes any "first arrival becomes admin" risk.
 */
export async function getCurrentUser(): Promise<StaffUser | null> {
  const env = getEnv();
  const db = getDb();
  const h = await headers();
  const email = await getAuthenticatedEmail(h, {
    APP_ENV: env.APP_ENV,
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: env.ACCESS_AUD,
  });
  if (!email) return null;

  let user = await getStaffByEmail(db, email);
  if (!user) {
    if (isBootstrapAdmin(email, env.STAFF_BOOTSTRAP_ADMINS)) {
      user = await createStaff(db, email, "admin");
    } else {
      return null; // authenticated but not authorised
    }
  }
  // A disabled account is treated as not authorised. getStaffByEmail still
  // returns the disabled row above, so the bootstrap path never tries to
  // re-create an existing-but-disabled user (which would hit UNIQUE(email)).
  if (user.disabled_at) return null;

  await touchLastLogin(db, user.id);
  return user;
}

function isBootstrapAdmin(email: string, allowlist: string | undefined): boolean {
  if (!allowlist) return false;
  const allowed = allowlist
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
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
