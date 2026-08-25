import type { Consent, Recipient } from "@/lib/types";

/**
 * A payout destination: one bank account, plus the mandate that pays into it.
 *
 * These are welded together on purpose. Plaid's consent/payment/execute accepts
 * only a consent_id and an amount, with no recipient, so the destination is
 * fixed at the moment the borrower approves the mandate and can never be
 * changed afterwards. Choosing where money lands therefore means choosing WHICH
 * MANDATE to collect against, never rerouting a payment.
 *
 * Proven against the Plaid UK sandbox: two mandates for one borrower at one bank
 * login stayed authorised simultaneously, and £1 collected against each landed
 * in that mandate's own account.
 */
export interface Destination {
  /**
   * Our local record of the account. NULL for a mandate we hold no account row
   * for, which happens with data predating this model.
   *
   * A missing row must never block a collection: Plaid executes against the
   * consent alone, so the mandate is what moves the money and this row is only
   * bookkeeping. Requiring it would let a gap in our own records stop a payment
   * the borrower already authorised, for no gain in safety.
   */
  recipient: Recipient | null;
  /** Null when limits have not been configured for this account yet. */
  consent: Consent | null;
}

/** What staff see in a picker. Falls back to the account name for pre-existing rows. */
export function destinationLabel(d: Destination): string {
  return d.recipient?.label?.trim() || d.recipient?.name || "Bank account on file";
}

/** Can money actually be collected into this account right now? */
export function isCollectable(d: Destination): boolean {
  return (
    d.recipient?.archived_at == null &&
    d.consent?.status === "authorized" &&
    d.consent.plaid_consent_id != null
  );
}

/**
 * Why a destination cannot be collected into, in words an operator can act on.
 *
 * Returns null when it is fine. Deliberately specific: "waiting for the
 * borrower to approve this account" and "no limits set yet" need completely
 * different actions, and a single "not ready" would send staff to the wrong one.
 */
export function blockedReason(d: Destination): string | null {
  if (d.recipient?.archived_at != null) return "This account has been retired.";
  if (!d.consent) return "No limits have been set for this account yet.";
  if (d.consent.status === "pending") {
    return "The borrower has not approved this account yet.";
  }
  if (d.consent.status === "revoked") return "The borrower cancelled this account's mandate.";
  if (d.consent.status === "expired") return "This account's mandate has expired.";
  if (d.consent.status === "rejected") return "The borrower declined this account.";
  if (!d.consent.plaid_consent_id) return "This account's mandate is not set up with the bank yet.";
  return null;
}

export type Resolution =
  | { ok: true; destination: Destination }
  | { ok: false; reason: string };

/**
 * Decide which destination a collection should pay into.
 *
 * `requestedConsentId` comes from a form, so it is untrusted input. It is
 * matched against THIS borrower's destinations only; an id belonging to someone
 * else is reported as not found rather than used. Without that check, a chosen
 * destination would be a way to pay a stranger's mandate using this borrower's
 * money, so the lookup is the security boundary and not merely a convenience.
 *
 * With no id requested, falls back to the default destination, which is how
 * scheduled runs and every pre-existing caller keep working unchanged.
 */
export function resolveDestination(
  destinations: Destination[],
  requestedConsentId?: string | null,
): Resolution {
  const requested = requestedConsentId?.trim();

  if (requested) {
    const match = destinations.find((d) => d.consent?.id === requested);
    // Same message whether the id is unknown or belongs to another borrower: an
    // operator can do nothing differently, and distinguishing them would confirm
    // that someone else's mandate exists.
    if (!match) return { ok: false, reason: "That account is not set up for this borrower." };
    const blocked = blockedReason(match);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, destination: match };
  }

  const collectable = destinations.filter(isCollectable);
  if (collectable.length === 0) {
    // Surface the most useful of the blocking reasons rather than a bare "none".
    const preferred = destinations.find((d) => d.recipient?.is_default) ?? destinations[0];
    return {
      ok: false,
      reason: preferred
        ? (blockedReason(preferred) ?? "No account is ready to receive money.")
        : "No bank account has been added for this borrower yet.",
    };
  }

  const preferred = collectable.find((d) => d.recipient?.is_default) ?? collectable[0];
  return { ok: true, destination: preferred };
}

/**
 * Total approved monthly headroom across every live mandate.
 *
 * Two mandates of £600/month each mean this borrower's banks will together
 * permit £1,200/month, which is NOT what someone reading a single mandate would
 * assume. Surfacing the combined figure is the point: the risk of this feature
 * is not technical, it is that the real ceiling stops being visible.
 *
 * Only mandates sharing the same period are summed, since adding a weekly cap to
 * a monthly one would produce a confident but meaningless number.
 */
export function combinedCeiling(
  destinations: Destination[],
): { period: string; totalMinor: number; currency: string; count: number } | null {
  const live = destinations
    .filter(isCollectable)
    .filter((d) => d.consent!.periodic_max_amount_minor != null && d.consent!.period);
  if (live.length < 2) return null;

  const period = live[0].consent!.period!;
  if (!live.every((d) => d.consent!.period === period)) return null;

  const currency = live[0].consent!.currency;
  if (!live.every((d) => d.consent!.currency === currency)) return null;

  return {
    period,
    currency,
    count: live.length,
    totalMinor: live.reduce((sum, d) => sum + d.consent!.periodic_max_amount_minor!, 0),
  };
}
