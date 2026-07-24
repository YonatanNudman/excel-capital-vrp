"use server";

import { getDb, getEnv } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { sha256Hex } from "@/lib/crypto";
import {
  getSetupLinkByHash,
  markSetupLinkUsed,
} from "@/lib/repo/setup-links";
import { getActiveConsent } from "@/lib/repo/consents";
import { writeAudit } from "@/lib/repo/audit";
import { confirmConsent } from "@/lib/engine/setup";

export type CompleteState = { done: boolean; message: string } | null;

/**
 * Called after the borrower finishes Plaid Link. Re-validates the token,
 * confirms authorization with Plaid, then marks the consent authorised, the
 * borrower active, and the setup link used. Idempotent on repeat calls.
 */
export async function completeSetupAction(
  _prev: CompleteState,
  fd: FormData,
): Promise<CompleteState> {
  const token = String(fd.get("token") ?? "");
  if (!token) return { done: false, message: "Missing token." };

  const db = getDb();
  const env = getEnv();
  const link = await getSetupLinkByHash(db, await sha256Hex(token));
  if (!link) return { done: false, message: "Invalid or expired link." };
  if (new Date(link.expires_at) < new Date()) {
    return { done: false, message: "This link has expired." };
  }

  const consent = await getActiveConsent(db, link.borrower_id);
  if (!consent) return { done: false, message: "No consent to confirm." };
  if (consent.status === "authorized") {
    await markSetupLinkUsed(db, link.id);
    return { done: true, message: "Already authorised. You're all set." };
  }

  const { status } = await confirmConsent(getPlaidClient(env), env.APP_ENCRYPTION_KEY, consent);
  if (status !== "AUTHORISED" && status !== "AUTHORIZED") {
    return { done: false, message: "Authorization is not complete. Please try again." };
  }

  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE consents SET status = 'authorized', authorized_at = ? WHERE id = ?")
      .bind(now, consent.id),
    db.prepare("UPDATE borrowers SET status = 'active' WHERE id = ?")
      .bind(link.borrower_id),
    db.prepare("UPDATE setup_links SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .bind(now, link.id),
  ]);
  await writeAudit(db, {
    actorStaffId: null,
    action: "consent.authorized",
    entityType: "borrower",
    entityId: link.borrower_id,
    metadata: { consentId: consent.id },
  });

  return { done: true, message: "Authorisation successful. Thank you." };
}
