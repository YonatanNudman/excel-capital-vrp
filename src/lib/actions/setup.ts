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
import { getBorrower } from "@/lib/repo/borrowers";
import { getMailer, type MailerEnv } from "@/lib/mailer";
import { setupLinkEmail } from "@/lib/mailer/templates";

const SETUP_LINK_TTL_HOURS = 72;

/**
 * Generate a fresh, single-use, expiring setup link for a borrower. Only the
 * token hash is stored; the full URL is returned once for staff to share, and
 * emailed to the borrower when a contact address is on file.
 */
export type SetupLinkState = { url?: string; error?: string; emailed?: boolean } | null;

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
  const url = `${base}/setup/${token}`;

  // Email the link to the borrower when we hold a contact address. Best-effort:
  // the link is always returned for staff to share even if delivery is off.
  let emailed = false;
  const borrower = await getBorrower(db, borrowerId);
  if (borrower?.contact_email) {
    const mailer = getMailer(env as MailerEnv);
    const { subject, text } = setupLinkEmail({
      borrowerName: borrower.legal_name,
      url,
      expiresHours: SETUP_LINK_TTL_HOURS,
    });
    const result = await mailer.send({ to: borrower.contact_email, subject, text });
    emailed = result.ok;
    await writeAudit(db, {
      actorStaffId: user.id,
      action: "email.setup_link",
      entityType: "borrower",
      entityId: borrowerId,
      metadata: { mode: mailer.mode, ok: result.ok, to: borrower.contact_email },
    });
  }

  revalidatePath(`/borrowers/${borrowerId}`);
  return { url, emailed };
}
