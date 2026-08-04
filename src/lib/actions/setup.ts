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
import { getRecipient } from "@/lib/repo/recipients";
import { getActiveConsent } from "@/lib/repo/consents";
import { setupReadiness } from "@/lib/readiness";
import { getMailer, type MailerEnv } from "@/lib/mailer";
import { setupLinkEmail } from "@/lib/mailer/templates";

const SETUP_LINK_TTL_HOURS = 72;

/**
 * Generate a fresh, single-use, expiring setup link for a borrower. Only the
 * token hash is stored; the full URL is returned once for staff to share, and
 * emailed to the borrower when a contact address is on file.
 */
export type SetupLinkState =
  | {
      url?: string;
      error?: string;
      /** True only when a real email was actually transmitted. */
      emailed?: boolean;
      /** False when no sending domain is configured, so staff must share it. */
      emailConfigured?: boolean;
    }
  | null;

export async function sendSetupLinkAction(
  _prev: SetupLinkState,
  fd: FormData,
): Promise<SetupLinkState> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();
  const borrowerId = fd.get("borrowerId");
  if (typeof borrowerId !== "string" || !borrowerId) {
    return { error: "Something went wrong: no borrower was selected." };
  }

  // Refuse to hand out a link that cannot possibly work. Plaid needs the
  // destination account and both consent caps, and without this check the
  // borrower is the one who discovers the gap, seeing only a generic error.
  const [recipient, consent] = await Promise.all([
    getRecipient(db, borrowerId),
    getActiveConsent(db, borrowerId),
  ]);
  const readiness = setupReadiness(recipient, consent);
  if (!readiness.ready) {
    return {
      error: `This borrower is not ready yet. ${readiness.missing.join(" ")}`,
    };
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
  // NOTE: the fallback LogMailer reports ok:true so callers treat the flow as
  // complete, so "did it send" must be judged on the mailer MODE, not on ok.
  // Claiming an email was sent when none was is worse than sending none: staff
  // stop chasing and the borrower waits for a link that never arrives.
  let emailed = false;
  let emailConfigured = false;
  const borrower = await getBorrower(db, borrowerId);
  if (borrower?.contact_email) {
    const mailer = getMailer(env as MailerEnv);
    const { subject, text } = setupLinkEmail({
      borrowerName: borrower.legal_name,
      url,
      expiresHours: SETUP_LINK_TTL_HOURS,
    });
    const result = await mailer.send({ to: borrower.contact_email, subject, text });
    emailConfigured = mailer.mode !== "log";
    emailed = result.ok && emailConfigured;
    await writeAudit(db, {
      actorStaffId: user.id,
      action: "email.setup_link",
      entityType: "borrower",
      entityId: borrowerId,
      metadata: { mode: mailer.mode, ok: result.ok, to: borrower.contact_email },
    });
  }

  revalidatePath(`/borrowers/${borrowerId}`);
  return { url, emailed, emailConfigured };
}
