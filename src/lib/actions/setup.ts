"use server";

import { revalidatePath } from "next/cache";
import { getDb, getEnv } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { writeAudit } from "@/lib/repo/audit";
import { createSetupToken } from "@/lib/crypto";
import {
  insertSetupLink,
  invalidateBorrowerLinks,
} from "@/lib/repo/setup-links";

const SETUP_LINK_TTL_HOURS = 72;

/**
 * Generate a fresh, single-use, expiring setup link for a borrower. Only the
 * token hash is stored; the full URL is returned once for staff to share. (Email
 * delivery is wired in a later stage.)
 */
export type SetupLinkState = { url?: string; error?: string } | null;

export async function sendSetupLinkAction(
  _prev: SetupLinkState,
  fd: FormData,
): Promise<SetupLinkState> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();
  const borrowerId = fd.get("borrowerId");
  if (typeof borrowerId !== "string" || !borrowerId) {
    return { error: "borrowerId required" };
  }

  await invalidateBorrowerLinks(db, borrowerId);

  const { token, hash } = await createSetupToken();
  const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_HOURS * 3600_000).toISOString();
  await insertSetupLink(db, {
    borrowerId,
    tokenHash: hash,
    expiresAt,
    createdBy: user.id,
  });

  await writeAudit(db, {
    actorStaffId: user.id,
    action: "setup_link.create",
    entityType: "borrower",
    entityId: borrowerId,
    metadata: { expiresAt },
  });

  const base = env.APP_BASE_URL ?? "";
  revalidatePath(`/borrowers/${borrowerId}`);
  return { url: `${base}/setup/${token}` };
}
