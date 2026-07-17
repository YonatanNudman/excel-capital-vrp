"use server";

import { getDb, getEnv } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { sha256Hex } from "@/lib/crypto";
import {
  getSetupLinkByHash,
  markSetupLinkUsed,
} from "@/lib/repo/setup-links";
import { getActiveConsent, setConsentStatus } from "@/lib/repo/consents";
import { setBorrowerStatus } from "@/lib/repo/borrowers";
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
    return { done: true, message: "Already authorised. You're all set." };
  }

  const { status } = await confirmConsent(getPlaidClient(env), env.APP_ENCRYPTION_KEY, consent);
  if (status !== "AUTHORISED") {
    return { done: false, message: `Authorization not complete (status: ${status}).` };
  }

  await setConsentStatus(db, consent.id, "authorized");
  await setBorrowerStatus(db, link.borrower_id, "active");
  await markSetupLinkUsed(db, link.id);
  await writeAudit(db, {
    actorStaffId: null,
    action: "consent.authorized",
    entityType: "borrower",
    entityId: link.borrower_id,
    metadata: { consentId: consent.id },
  });

  return { done: true, message: "Authorisation successful. Thank you." };
}
