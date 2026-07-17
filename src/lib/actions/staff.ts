"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { writeAudit } from "@/lib/repo/audit";
import {
  createStaff,
  getStaffByEmail,
  setStaffDisabled,
  setStaffRole,
  staffChangeGuard,
} from "@/lib/repo/staff";
import type { Role } from "@/lib/types";

export type StaffActionState = { message: string } | null;

const ROLES: Role[] = ["admin", "operator", "viewer"];

function readRole(fd: FormData): Role | null {
  const v = String(fd.get("role") ?? "");
  return ROLES.includes(v as Role) ? (v as Role) : null;
}

/** Add a new staff member (admin only). */
export async function addStaffAction(
  _prev: StaffActionState,
  fd: FormData,
): Promise<StaffActionState> {
  const actor = await requireRole("admin");
  const db = getDb();

  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const role = readRole(fd);
  if (!email || !email.includes("@")) {
    return { message: "Enter a valid email address." };
  }
  if (!role) return { message: "Choose a role." };

  const existing = await getStaffByEmail(db, email);
  if (existing) {
    return { message: `${email} is already a staff member.` };
  }

  const created = await createStaff(db, email, role);
  await writeAudit(db, {
    actorStaffId: actor.id,
    action: "staff.add",
    entityType: "staff",
    entityId: created.id,
    metadata: { email, role },
  });
  revalidatePath("/staff");
  return { message: `Added ${email} as ${role}.` };
}

/** Change a staff member's role (admin only), guarded against lockout. */
export async function setStaffRoleAction(
  _prev: StaffActionState,
  fd: FormData,
): Promise<StaffActionState> {
  const actor = await requireRole("admin");
  const db = getDb();

  const staffId = String(fd.get("staffId") ?? "");
  const role = readRole(fd);
  if (!staffId || !role) return { message: "Missing staff id or role." };

  const blocked = await staffChangeGuard(db, actor.id, staffId, { role });
  if (blocked) return { message: blocked };

  await setStaffRole(db, staffId, role);
  await writeAudit(db, {
    actorStaffId: actor.id,
    action: "staff.role",
    entityType: "staff",
    entityId: staffId,
    metadata: { role },
  });
  revalidatePath("/staff");
  return { message: `Role updated to ${role}.` };
}

/** Disable or enable a staff member (admin only), guarded against lockout. */
export async function setStaffDisabledAction(
  _prev: StaffActionState,
  fd: FormData,
): Promise<StaffActionState> {
  const actor = await requireRole("admin");
  const db = getDb();

  const staffId = String(fd.get("staffId") ?? "");
  const disable = String(fd.get("disable") ?? "") === "true";
  if (!staffId) return { message: "Missing staff id." };

  const blocked = await staffChangeGuard(db, actor.id, staffId, { disable });
  if (blocked) return { message: blocked };

  await setStaffDisabled(db, staffId, disable);
  await writeAudit(db, {
    actorStaffId: actor.id,
    action: disable ? "staff.disable" : "staff.enable",
    entityType: "staff",
    entityId: staffId,
  });
  revalidatePath("/staff");
  return { message: disable ? "Staff member disabled." : "Staff member enabled." };
}
