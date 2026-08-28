import type { Destination } from "@/lib/destinations";
import { destinationLabel } from "@/lib/destinations";

/**
 * Has this borrower finished their side of setup?
 *
 * The status badge cannot answer that. It says whether the borrower can be
 * collected from, which is a different question the moment a borrower has more
 * than one payout account: one approved account makes them active while a second
 * is still sitting unapproved, and an operator reading "Active" has no way to
 * know they are waiting on anything.
 *
 * Staff were asking it out loud ("how do I know when a client has done
 * everything their end?"), and the only place to look was the per-account list
 * on one borrower's page. Every fact needed was already in the database and
 * appeared on no screen that shows more than one borrower at a time.
 *
 * Split three ways because the three need completely different actions:
 *   - approved:         nothing to do.
 *   - awaitingBorrower: chase the borrower, or send them a fresh link.
 *   - needsStaff:       the borrower CANNOT act yet; someone here must finish
 *                       the account details or issue a new mandate first.
 * Collapsing the last two into "not done" would send staff to chase a borrower
 * for something only staff can fix.
 */
export interface SetupProgress {
  /** Live accounts the borrower is being asked to approve. Excludes retired ones. */
  total: number;
  approved: number;
  awaitingBorrower: number;
  needsStaff: number;
  /** Nothing outstanding on either side, and at least one account is live. */
  complete: boolean;
  /** Short phrase for a table cell. */
  label: string;
  /** One sentence naming what is outstanding and whose move it is. */
  detail: string;
}

/** Which of the three buckets one account falls into. */
function bucket(d: Destination): "approved" | "borrower" | "staff" {
  const status = d.consent?.status;
  if (status === "authorized") return "approved";
  // Pending is the borrower's move, but only once the account is actually
  // provisionable: without bank details or limits, provisioning throws and the
  // borrower meets "Setup is temporarily unavailable" however many times they
  // open the link. That is staff's move, not theirs.
  if (status === "pending") {
    const ready =
      Boolean(d.recipient?.account_number?.trim()) &&
      Boolean(d.recipient?.sort_code?.trim()) &&
      (d.consent!.max_payment_amount_minor ?? 0) > 0 &&
      (d.consent!.periodic_max_amount_minor ?? 0) > 0;
    return ready ? "borrower" : "staff";
  }
  // No consent at all, or one that is revoked, expired or rejected. Reopening a
  // link cannot fix any of those: a fresh mandate has to be created first.
  return "staff";
}

export function setupProgress(destinations: Destination[]): SetupProgress {
  // A retired account is nobody's outstanding work. Leaving it in would keep a
  // borrower permanently "not finished" over an account that was abandoned.
  const live = destinations.filter((d) => d.recipient?.archived_at == null);

  let approved = 0;
  let awaitingBorrower = 0;
  let needsStaff = 0;
  const waitingOn: string[] = [];
  for (const d of live) {
    const where = bucket(d);
    if (where === "approved") approved++;
    else if (where === "borrower") {
      awaitingBorrower++;
      waitingOn.push(destinationLabel(d));
    } else needsStaff++;
  }

  const total = live.length;
  const complete = total > 0 && awaitingBorrower === 0 && needsStaff === 0;

  if (total === 0) {
    return {
      total, approved, awaitingBorrower, needsStaff, complete,
      label: "No account yet",
      detail: "No bank account has been added, so there is nothing to send the borrower yet.",
    };
  }

  if (complete) {
    return {
      total, approved, awaitingBorrower, needsStaff, complete,
      label: "All approved",
      detail:
        total === 1
          ? "The borrower has approved their account. Nothing outstanding on their side."
          : `The borrower has approved all ${total} accounts. Nothing outstanding on their side.`,
    };
  }

  if (awaitingBorrower > 0) {
    // Name the accounts, so an operator chasing a borrower knows what to chase
    // about rather than only that something is missing.
    const named = waitingOn.join(", ");
    return {
      total, approved, awaitingBorrower, needsStaff, complete,
      label:
        approved > 0
          ? `${approved} of ${total} approved`
          : awaitingBorrower === 1
            ? "1 to approve"
            : `${awaitingBorrower} to approve`,
      detail:
        awaitingBorrower === 1
          ? `Waiting on the borrower to approve ${named} with their bank.`
          : `Waiting on the borrower to approve ${awaitingBorrower} accounts with their bank: ${named}.`,
    };
  }

  return {
    total, approved, awaitingBorrower, needsStaff, complete,
    label: "Needs your input",
    detail:
      needsStaff === 1
        ? "One account is not ready to send to the borrower yet. Finish it here first."
        : `${needsStaff} accounts are not ready to send to the borrower yet. Finish them here first.`,
  };
}
