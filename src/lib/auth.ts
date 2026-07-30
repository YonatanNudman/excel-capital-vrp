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
  // Pass the whole env rather than hand-picking fields: AccessEnv reads only
  // what it needs, and forwarding everything means adding a new Access setting
  // never silently fails to reach this call site.
  const email = await getAuthenticatedEmail(h, env);
  if (!email) return null;

  let user = await getStaffByEmail(db, email);
  if (!user) {
    const role = autoProvisionRole(email, env);
    if (!role) return null; // authenticated but not authorised
    user = await createStaff(db, email, role);
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

export interface ProvisionEnv {
  APP_ENV?: string;
  STAFF_BOOTSTRAP_ADMINS?: string;
  STAFF_AUTO_PROVISION_DOMAIN?: string;
}

/**
 * Decide what role, if any, an authenticated but unknown email should be
 * created with.
 *
 * Two paths, deliberately different in power:
 *  - STAFF_BOOTSTRAP_ADMINS: an explicit address list, provisioned as admin.
 *  - STAFF_AUTO_PROVISION_DOMAIN: anyone at one domain, provisioned as
 *    OPERATOR only, and only outside production. This lets a group of testers
 *    sign themselves in without anyone maintaining a list, at the cost of
 *    trusting everyone who can receive mail at that domain. That trade is fine
 *    for sandbox money and unacceptable for real money, hence the env guard.
 *
 * Returns null when the address should not be provisioned at all.
 */
export function autoProvisionRole(email: string, env: ProvisionEnv): Role | null {
  const normalised = email.trim().toLowerCase();
  if (isBootstrapAdmin(normalised, env.STAFF_BOOTSTRAP_ADMINS)) return "admin";

  if (env.APP_ENV === "production") return null;
  const domain = env.STAFF_AUTO_PROVISION_DOMAIN?.trim().toLowerCase();
  if (!domain) return null;

  // Compare the domain part exactly. endsWith() would accept both
  // "someone@notexcelcapital.co.uk" and "excelcapital.co.uk@evil.example".
  const at = normalised.lastIndexOf("@");
  if (at === -1) return null;
  return normalised.slice(at + 1) === domain ? "operator" : null;
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
