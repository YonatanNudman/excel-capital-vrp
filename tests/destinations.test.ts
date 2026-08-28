import { describe, it, expect } from "vitest";
import {
  blockedReason,
  combinedCeiling,
  destinationLabel,
  isCollectable,
  resolveDestination,
  type Destination,
} from "@/lib/destinations";
import type { Consent, Recipient } from "@/lib/types";

const recipient = (over: Partial<Recipient> = {}): Recipient =>
  ({
    id: "r1",
    borrower_id: "b1",
    plaid_recipient_id: "plaid-r1",
    name: "Excel Capital main",
    account_number: null,
    sort_code: null,
    label: null,
    is_default: 1,
    archived_at: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  }) as Recipient;

const consent = (over: Partial<Consent> = {}): Consent =>
  ({
    id: "c1",
    borrower_id: "b1",
    plaid_consent_id: "cipher",
    plaid_consent_id_hash: "hash",
    plaid_recipient_id: "plaid-r1",
    recipient_id: "r1",
    status: "authorized",
    currency: "GBP",
    max_payment_amount_minor: 60_000,
    period: "MONTH",
    periodic_alignment: "CALENDAR",
    periodic_max_amount_minor: 300_000,
    valid_from: null,
    valid_to: null,
    authorized_at: "2026-08-01T00:00:00Z",
    raw_constraints: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  }) as Consent;

/** A ready-to-collect destination. */
const dest = (r: Partial<Recipient> = {}, c: Partial<Consent> | null = {}): Destination => ({
  recipient: recipient(r),
  consent: c === null ? null : consent(c),
});

const main = dest();
const backup = dest(
  { id: "r2", name: "Excel Capital backup", label: "Backup account", is_default: 0 },
  { id: "c2", recipient_id: "r2" },
);

describe("destinationLabel", () => {
  it("prefers the staff label", () => {
    expect(destinationLabel(backup)).toBe("Backup account");
  });

  it("falls back to the account name for rows predating labels", () => {
    expect(destinationLabel(main)).toBe("Excel Capital main");
  });

  it("treats a whitespace-only label as no label", () => {
    expect(destinationLabel(dest({ label: "   " }))).toBe("Excel Capital main");
  });
});

describe("isCollectable", () => {
  it("accepts an authorised, provisioned, unarchived account", () => {
    expect(isCollectable(main)).toBe(true);
  });

  it("refuses an archived account even when its mandate is still authorised", () => {
    expect(isCollectable(dest({ archived_at: "2026-08-05T00:00:00Z" }))).toBe(false);
  });

  it("refuses an account with no mandate at all", () => {
    expect(isCollectable(dest({}, null))).toBe(false);
  });

  it("refuses an authorised mandate that was never provisioned with the bank", () => {
    // Status says yes but there is nothing to execute against, so collecting
    // would fail at the provider after we had already written a payment row.
    expect(isCollectable(dest({}, { plaid_consent_id: null }))).toBe(false);
  });

  it.each(["pending", "revoked", "expired", "rejected"] as const)(
    "refuses a %s mandate",
    (status) => {
      expect(isCollectable(dest({}, { status }))).toBe(false);
    },
  );
});

describe("blockedReason: tells staff what to actually do", () => {
  it("says nothing when the destination is fine", () => {
    expect(blockedReason(main)).toBeNull();
  });

  it("distinguishes 'no limits set' from 'borrower has not approved'", () => {
    // These need opposite actions: one is staff's job, one is the borrower's.
    // A shared "not ready" would send staff chasing the wrong person.
    expect(blockedReason(dest({}, null))).toMatch(/limits/i);
    expect(blockedReason(dest({}, { status: "pending" }))).toMatch(/borrower/i);
  });

  it("names revoked and expired separately, since only one can be renewed", () => {
    expect(blockedReason(dest({}, { status: "revoked" }))).toMatch(/cancelled/i);
    expect(blockedReason(dest({}, { status: "expired" }))).toMatch(/expired/i);
  });

  it("reports archived before anything else", () => {
    expect(blockedReason(dest({ archived_at: "2026-08-05T00:00:00Z" }, null))).toMatch(/retired/i);
  });
});

describe("resolveDestination: choosing where the money lands", () => {
  it("uses the requested account when it is this borrower's and ready", () => {
    const r = resolveDestination([main, backup], "c2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.recipient?.id).toBe("r2");
  });

  /**
   * THE security boundary. requestedConsentId arrives from a form, so an id
   * belonging to a different borrower must be refused, not used. Otherwise a
   * chosen destination becomes a way to pay a stranger's mandate.
   */
  it("refuses a consent id belonging to a different borrower", () => {
    const r = resolveDestination([main, backup], "c-someone-else");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not set up for this borrower/i);
  });

  it("gives the same answer for an unknown id as for someone else's", () => {
    // Distinguishing them would confirm that another borrower's mandate exists.
    const unknown = resolveDestination([main], "does-not-exist");
    const foreign = resolveDestination([main], "c2");
    expect(unknown).toEqual(foreign);
  });

  it("refuses a requested account that exists but is not ready", () => {
    const pending = dest({ id: "r3", is_default: 0 }, { id: "c3", status: "pending" });
    const r = resolveDestination([main, pending], "c3");
    expect(r.ok).toBe(false);
    // Never silently falls back to the default: the operator picked an account
    // deliberately, and quietly paying a different one would be worse than
    // refusing, because the money would be real and the choice ignored.
    if (!r.ok) expect(r.reason).toMatch(/borrower/i);
  });

  it("falls back to the default account when nothing is requested", () => {
    const r = resolveDestination([backup, main]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.recipient?.id).toBe("r1");
  });

  it("treats an empty or whitespace request as no request", () => {
    for (const value of ["", "   ", null, undefined]) {
      const r = resolveDestination([main], value);
      expect(r.ok).toBe(true);
    }
  });

  it("uses the only ready account when the default one is not ready", () => {
    const brokenDefault = dest({ is_default: 1 }, { status: "revoked" });
    const r = resolveDestination([brokenDefault, backup]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.recipient?.id).toBe("r2");
  });

  it("explains why when no account is ready, rather than saying 'none'", () => {
    const r = resolveDestination([dest({}, { status: "pending" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/borrower/i);
  });

  it("handles a borrower with no accounts at all", () => {
    const r = resolveDestination([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no bank account/i);
  });
});

describe("a mandate with no local account row", () => {
  /**
   * Found while building this: requiring a recipients row before collecting
   * silently turned 24 previously-working collections into "skipped". Plaid
   * executes against the consent alone, so a missing local row is a bookkeeping
   * gap, and treating it as a blocker would stop payments the borrower already
   * authorised. Reachable for data written before mandates recorded an account.
   */
  const orphan: Destination = { recipient: null, consent: consent({ recipient_id: null }) };

  it("is still collectable", () => {
    expect(isCollectable(orphan)).toBe(true);
    expect(blockedReason(orphan)).toBeNull();
  });

  it("is used as the fallback when it is all there is", () => {
    const r = resolveDestination([orphan]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.consent?.id).toBe("c1");
  });

  it("can be chosen explicitly by its consent id", () => {
    const r = resolveDestination([orphan], "c1");
    expect(r.ok).toBe(true);
  });

  it("loses to a real default account when both are available", () => {
    // The named account is what staff recognise, so prefer it when there is a
    // choice; the orphan remains reachable by explicit id.
    const r = resolveDestination([orphan, main]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.recipient?.id).toBe("r1");
  });

  it("gets a label a human can read rather than blank", () => {
    expect(destinationLabel(orphan)).toBe("Bank account on file");
  });
});

describe("combinedCeiling: the real risk of this feature", () => {
  /**
   * Two £3,000/month mandates mean the banks will together permit £6,000/month.
   * Nobody reading one mandate would guess that, so the combined figure has to
   * be visible. This is the compliance question raised with Plaid, and the
   * number is what makes it answerable.
   */
  it("sums the periodic caps across live mandates", () => {
    const c = combinedCeiling([main, backup]);
    expect(c).not.toBeNull();
    expect(c!.totalMinor).toBe(600_000);
    expect(c!.count).toBe(2);
    expect(c!.period).toBe("MONTH");
  });

  it("says nothing when there is only one live mandate", () => {
    // One mandate's ceiling is already shown on its own; repeating it as a
    // "combined" total would imply a risk that does not exist.
    expect(combinedCeiling([main])).toBeNull();
    expect(combinedCeiling([main, dest({ id: "r2" }, { id: "c2", status: "pending" })])).toBeNull();
  });

  it("refuses to add a weekly cap to a monthly one", () => {
    // The sum would be a confident, meaningless number.
    const weekly = dest({ id: "r2", is_default: 0 }, { id: "c2", period: "WEEK" });
    expect(combinedCeiling([main, weekly])).toBeNull();
  });

  it("refuses to add across currencies", () => {
    const eur = dest({ id: "r2", is_default: 0 }, { id: "c2", currency: "EUR" });
    expect(combinedCeiling([main, eur])).toBeNull();
  });

  it("ignores archived accounts, which cannot contribute headroom", () => {
    const archived = dest(
      { id: "r2", is_default: 0, archived_at: "2026-08-05T00:00:00Z" },
      { id: "c2" },
    );
    expect(combinedCeiling([main, archived])).toBeNull();
  });
});

describe("choosing where a collection goes when nobody named an account", () => {
  /**
   * The silent version of a wrong-destination bug. When the default account's
   * mandate was pending or revoked, the resolver fell through to "the first
   * collectable one", so a scheduled collection quietly paid a spare account and
   * the only record was in a payment history nobody re-reads.
   */
  it("refuses when several accounts could receive it and none is the default", () => {
    const result = resolveDestination([
      { recipient: recipient({ id: "r1", is_default: 0 }), consent: consent({ id: "c1", status: "authorized", plaid_consent_id: "p1" }) },
      { recipient: recipient({ id: "r2", is_default: 0 }), consent: consent({ id: "c2", status: "authorized", plaid_consent_id: "p2" }) },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/default/i);
  });

  it("uses the only collectable account without complaint", () => {
    // Every single-account borrower, and every legacy mandate held without an
    // account row of its own.
    const result = resolveDestination([
      { recipient: null, consent: consent({ id: "c1", status: "authorized", plaid_consent_id: "p1" }) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.destination.consent?.id).toBe("c1");
  });

  it("follows the default when there is one", () => {
    const result = resolveDestination([
      { recipient: recipient({ id: "r1", is_default: 0 }), consent: consent({ id: "c1", status: "authorized", plaid_consent_id: "p1" }) },
      { recipient: recipient({ id: "r2", is_default: 1 }), consent: consent({ id: "c2", status: "authorized", plaid_consent_id: "p2" }) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.destination.consent?.id).toBe("c2");
  });
});
