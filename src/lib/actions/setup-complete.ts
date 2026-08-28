"use server";

import { getDb, getEnv } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { sha256Hex } from "@/lib/crypto";
import {
  getSetupLinkByHash,
  markSetupLinkUsed,
} from "@/lib/repo/setup-links";
import {
  allPendingConsentsForBorrower,
  pendingConsentsForBorrower,
} from "@/lib/repo/consents";
import { writeAudit } from "@/lib/repo/audit";
import { activateBorrowerOnLiveMandate } from "@/lib/repo/borrowers";
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
  // Two different questions, deliberately two different lists. `toConfirm`
  // includes mandates on retired accounts, because the bank may have made one
  // live while an operator was retiring it and a mandate we stopped tracking is
  // worse than a tidy list. `outstanding` drives what the borrower is told, and
  // excludes them, so an abandoned account never approved cannot strand them.
  const [toConfirm, outstanding] = await Promise.all([
    allPendingConsentsForBorrower(db, link.borrower_id),
    pendingConsentsForBorrower(db, link.borrower_id),
  ]);
  if (toConfirm.length === 0) {
    await markSetupLinkUsed(db, link.id);
    return { done: true, message: "Already authorised. You're all set." };
  }

  const plaid = getPlaidClient(env);
  const nowIso = new Date().toISOString();
  const authorised = new Set<string>();

  for (const consent of toConfirm) {
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
      metadata: {
        consentId: consent.id,
        recipientId: consent.recipient_id,
        // Worth finding in the audit trail later: a live mandate on an account
        // that was retired mid-approval.
        recipientArchived: !outstanding.some((o) => o.id === consent.id),
      },
    });
    authorised.add(consent.id);
  }

  // Counted against what the borrower still has to do, not against everything
  // confirmed, so approving a retired account does not change their progress.
  const stillPending = outstanding.filter((c) => !authorised.has(c.id)).length;

  if (stillPending > 0 && authorised.size === 0) {
    return { done: false, message: "Authorization is not complete. Please try again." };
  }

  // Collectable the moment ONE account is approved, so the status stops
  // disagreeing with what the engine will actually do: a borrower with an
  // approved account is collected from whether or not a second account is still
  // outstanding. "Has the borrower finished everything" is a different question,
  // answered on screen by the setup progress rather than by this badge.
  if (authorised.size > 0) {
    await activateBorrowerOnLiveMandate(db, link.borrower_id);
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

  // Every account approved, so the link has done its job and is spent. The
  // status was already moved above; a paused borrower stays paused.
  await db
    .prepare("UPDATE setup_links SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(nowIso, link.id)
    .run();

  return { done: true, message: "Authorisation successful. Thank you." };
}
