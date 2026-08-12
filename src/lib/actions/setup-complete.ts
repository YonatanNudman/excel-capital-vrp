"use server";

import { getDb, getEnv } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { sha256Hex } from "@/lib/crypto";
import {
  getSetupLinkByHash,
  markSetupLinkUsed,
} from "@/lib/repo/setup-links";
import { pendingConsentsForBorrower } from "@/lib/repo/consents";
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

  // A borrower can hold several mandates, one per payout account, so check every
  // one still pending rather than a single "active" consent. Plaid is the
  // authority here, not the Link callback: during the two-mandate test Link
  // reported INTERNAL_SERVER_ERROR on a mandate that had in fact authorised
  // correctly. Trusting the callback would have told that borrower their account
  // failed when it had not.
  const pending = await pendingConsentsForBorrower(db, link.borrower_id);
  if (pending.length === 0) {
    await markSetupLinkUsed(db, link.id);
    return { done: true, message: "Already authorised. You're all set." };
  }

  const plaid = getPlaidClient(env);
  const nowIso = new Date().toISOString();
  let confirmed = 0;

  for (const consent of pending) {
    // Never provisioned with the bank, so there is nothing to confirm yet.
    if (!consent.plaid_consent_id) continue;
    const { status } = await confirmConsent(plaid, env.APP_ENCRYPTION_KEY, consent);
    if (status !== "AUTHORISED" && status !== "AUTHORIZED") continue;

    await db
      .prepare("UPDATE consents SET status = 'authorized', authorized_at = ? WHERE id = ?")
      .bind(nowIso, consent.id)
      .run();
    await writeAudit(db, {
      actorStaffId: null,
      action: "consent.authorized",
      entityType: "borrower",
      entityId: link.borrower_id,
      metadata: { consentId: consent.id, recipientId: consent.recipient_id },
    });
    confirmed++;
  }

  const stillPending = pending.length - confirmed;

  if (confirmed === 0) {
    return { done: false, message: "Authorization is not complete. Please try again." };
  }

  if (stillPending > 0) {
    // The link stays usable on purpose: it is the borrower's only way back to
    // approve the remaining accounts. Marking it used here would lock them out
    // halfway through and require staff to notice and send a new one.
    return {
      done: false,
      message:
        stillPending === 1
          ? "That account is approved. One more account to approve, then you're done."
          : `That account is approved. ${stillPending} more accounts to approve.`,
    };
  }

  // Every account approved: only now is the borrower collectable and the link spent.
  await db.batch([
    db.prepare("UPDATE borrowers SET status = 'active' WHERE id = ?").bind(link.borrower_id),
    db
      .prepare("UPDATE setup_links SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .bind(nowIso, link.id),
  ]);

  return { done: true, message: "Authorisation successful. Thank you." };
}
