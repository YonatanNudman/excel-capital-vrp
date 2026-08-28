"use server";

import { getDb } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { borrowerIdForSetupToken } from "@/lib/repo/setup-links";
import { SETUP_FAILED_ACTION, writeAudit } from "@/lib/repo/audit";

/** Nothing here is trusted, so everything is bounded before it reaches the log. */
function clamp(value: FormDataEntryValue | null, max = 300): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Record why a borrower's bank authorisation failed.
 *
 * Plaid tells us exactly what went wrong — an error code, its own message, and
 * which institution the borrower picked — and every bit of it was going to
 * `console.error` in the borrower's browser and nowhere else. So when a real
 * borrower failed on a real bank, the only evidence anyone here had was whatever
 * they thought to screenshot on their phone, and diagnosis became guesswork
 * about a company's money. One HSBC failure cost most of a morning that way.
 *
 * Public on purpose, like completeSetupAction: the caller is the borrower, who
 * has no staff login. The setup token is the authentication, and this grants
 * nothing — it resolves a borrower id and writes one audit row. An unrecognised
 * token records nothing at all rather than creating an entry an operator would
 * have to interpret.
 */
export async function recordSetupErrorAction(fd: FormData): Promise<void> {
  const token = clamp(fd.get("token"), 200);
  if (!token) return;

  const db = getDb();
  const borrowerId = await borrowerIdForSetupToken(db, await sha256Hex(token));
  if (!borrowerId) return;

  await writeAudit(db, {
    actorStaffId: null,
    action: SETUP_FAILED_ACTION,
    entityType: "borrower",
    entityId: borrowerId,
    metadata: {
      // Plaid's own words, kept separate: the code is what to quote at support,
      // the display message is what the borrower actually saw on screen.
      errorCode: clamp(fd.get("errorCode"), 100),
      errorType: clamp(fd.get("errorType"), 100),
      errorMessage: clamp(fd.get("errorMessage"), 500),
      displayMessage: clamp(fd.get("displayMessage"), 500),
      // Which bank they chose, which is the first thing anyone asks and the one
      // thing a screenshot of an error box never shows.
      institutionName: clamp(fd.get("institutionName"), 120),
      institutionId: clamp(fd.get("institutionId"), 100),
      // Plaid's own session id: hand this to Plaid support and they can see the
      // whole journey without anyone reconstructing it from memory.
      linkSessionId: clamp(fd.get("linkSessionId"), 100),
      requestId: clamp(fd.get("requestId"), 100),
      status: clamp(fd.get("status"), 100),
    },
  });
}
