/**
 * Payment state machine.
 *
 * Internal states are our source of truth; Plaid statuses drive transitions via
 * webhooks. Key business rule: PAYMENT_STATUS_INITIATED means "the bank accepted
 * the payment for processing" and is treated as successfully SUBMITTED, not a
 * failure, and not final settlement.
 *
 * Pure, I/O-free, and unit-tested by the scenario evals.
 */

export type InternalStatus =
  | "pending"
  | "unknown"
  | "submitted"
  | "initiated"
  | "executed"
  | "settled"
  | "failed"
  | "rejected"
  | "cancelled";

/** Terminal states never transition further. */
export const TERMINAL_STATES: ReadonlySet<InternalStatus> = new Set([
  "settled",
  "rejected",
  "cancelled",
]);

/** Statuses that count as "money is on its way or arrived" (do not re-collect). */
export const IN_FLIGHT_OR_DONE: ReadonlySet<InternalStatus> = new Set([
  "unknown",
  "submitted",
  "initiated",
  "executed",
  "settled",
]);

/** Failures eligible for retry (subject to the configured retry policy). */
export const RETRY_ELIGIBLE: ReadonlySet<InternalStatus> = new Set(["failed"]);

/**
 * Map a Plaid payment status string to our internal status.
 * Unknown statuses return null (caller should log and leave state unchanged).
 */
export function mapPlaidStatus(plaidStatus: string): InternalStatus | null {
  switch (plaidStatus) {
    case "PAYMENT_STATUS_INPUT_NEEDED":
    case "PAYMENT_STATUS_AUTHORISING":
      return "pending";
    case "PAYMENT_STATUS_INITIATED":
      return "initiated";
    case "PAYMENT_STATUS_EXECUTED":
      return "executed";
    case "PAYMENT_STATUS_SETTLED":
      return "settled";
    case "PAYMENT_STATUS_INSUFFICIENT_FUNDS":
    case "PAYMENT_STATUS_FAILED":
    case "PAYMENT_STATUS_BLOCKED":
      return "failed";
    case "PAYMENT_STATUS_REJECTED":
      return "rejected";
    case "PAYMENT_STATUS_CANCELLED":
      return "cancelled";
    default:
      return null;
  }
}

/** Rank used to prevent a stale/duplicate webhook from moving state backwards. */
const PROGRESS_RANK: Record<InternalStatus, number> = {
  pending: 0,
  unknown: 1,
  submitted: 1,
  initiated: 2,
  executed: 3,
  settled: 4,
  // failure states are "off the happy path"; ranked high so they stick unless already settled
  failed: 3,
  rejected: 4,
  cancelled: 4,
};

/**
 * Decide whether a transition from `current` to `next` should be applied.
 * Guards against out-of-order / duplicate webhooks:
 *  - never leave a terminal state
 *  - never regress to a lower-progress status
 */
export function canTransition(current: InternalStatus, next: InternalStatus): boolean {
  if (current === next) return false; // no-op, e.g. duplicate webhook
  if (TERMINAL_STATES.has(current)) return false;
  if (current === "unknown") return true;
  if (next === "unknown") return !IN_FLIGHT_OR_DONE.has(current);
  return PROGRESS_RANK[next] >= PROGRESS_RANK[current];
}
