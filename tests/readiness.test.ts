import { describe, it, expect } from "vitest";
import { setupReadiness, destinationsReadiness } from "@/lib/readiness";
import type { Consent, Recipient } from "@/lib/types";

const recipient = (over: Partial<Recipient> = {}): Recipient => ({
  id: "rec1",
  borrower_id: "bor1",
  plaid_recipient_id: null,
  name: "Excel Capital Group Ltd",
  account_number: "12345678",
  sort_code: "123456",
  label: null,
  is_default: 1,
  archived_at: null,
  created_at: "",
  ...over,
});

const consent = (over: Partial<Consent> = {}): Consent =>
  ({
    id: "con1",
    borrower_id: "bor1",
    plaid_consent_id: null,
    plaid_consent_id_hash: null,
    plaid_recipient_id: null,
    status: "pending",
    currency: "GBP",
    max_payment_amount_minor: 50_000,
    period: "MONTH",
    periodic_alignment: "CALENDAR",
    periodic_max_amount_minor: 200_000,
    valid_from: null,
    valid_to: null,
    authorized_at: null,
    ...over,
  }) as Consent;

describe("setupReadiness: ready", () => {
  it("is ready when bank details and both consent limits are present", () => {
    const r = setupReadiness(recipient(), consent());
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe("setupReadiness: missing bank details", () => {
  it("reports a missing account number", () => {
    const r = setupReadiness(recipient({ account_number: null }), consent());
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/account number/i);
  });

  it("reports a missing sort code", () => {
    const r = setupReadiness(recipient({ sort_code: "" }), consent());
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/sort code/i);
  });

  it("reports everything when there is no recipient at all", () => {
    const r = setupReadiness(null, consent());
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/bank account|bank details/i);
  });
});

describe("setupReadiness: missing consent limits", () => {
  // This is what actually broke for Sussex Road Investments Limited: the
  // borrower was created with no limits, so Plaid rejected the consent and the
  // borrower saw "Setup is temporarily unavailable".
  it("reports a missing per-payment cap", () => {
    const r = setupReadiness(recipient(), consent({ max_payment_amount_minor: null }));
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/most.*single payment|per.payment/i);
  });

  it("reports a missing periodic cap", () => {
    const r = setupReadiness(recipient(), consent({ periodic_max_amount_minor: null }));
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/period/i);
  });

  it("reports a missing period even when the periodic amount is set", () => {
    const r = setupReadiness(recipient(), consent({ period: null }));
    expect(r.ready).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it("treats a zero cap as missing, not as a valid limit of nothing", () => {
    const r = setupReadiness(recipient(), consent({ max_payment_amount_minor: 0 }));
    expect(r.ready).toBe(false);
  });

  it("reports everything when there is no consent row", () => {
    const r = setupReadiness(recipient(), null);
    expect(r.ready).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });
});

describe("setupReadiness: reports every problem at once", () => {
  it("lists all four missing items rather than stopping at the first", () => {
    const r = setupReadiness(
      recipient({ account_number: null, sort_code: null }),
      consent({ max_payment_amount_minor: null, periodic_max_amount_minor: null }),
    );
    expect(r.ready).toBe(false);
    // Staff should be able to fix everything in one pass.
    expect(r.missing.length).toBeGreaterThanOrEqual(3);
  });

  it("writes messages an operator can act on, with no jargon or field names", () => {
    const r = setupReadiness(null, null);
    for (const m of r.missing) {
      expect(m).not.toMatch(/minor|_|null|undefined|Plaid/);
      expect(m.length).toBeGreaterThan(10);
    }
  });
});

describe("destinationsReadiness: every account the borrower must approve", () => {
  const dest = (
    label: string,
    r: Partial<Recipient> | null,
    c: Partial<Consent> | null,
  ) => ({
    label,
    recipient: r === null ? null : recipient(r),
    consent: c === null ? null : consent(c),
  });

  /** Complete and unauthorised: ready to be sent to the borrower. */
  const complete = (label: string, over: Partial<Recipient> = {}) =>
    dest(label, over, { max_payment_amount_minor: 60_000, periodic_max_amount_minor: 300_000, period: "MONTH" });

  it("is ready when the only account is complete", () => {
    expect(destinationsReadiness([complete("Main")]).ready).toBe(true);
  });

  /**
   * The bug this function exists to fix a second time. Provisioning walks every
   * account in turn and throws on the first one missing bank details, so checking
   * only one account moved the borrower's dead end later rather than removing it.
   */
  it("catches a second account missing bank details", () => {
    const result = destinationsReadiness([
      complete("Main"),
      complete("Backup", { account_number: null }),
    ]);
    expect(result.ready).toBe(false);
    expect(result.missing.join(" ")).toMatch(/account number/i);
  });

  it("names which account is incomplete when there is more than one", () => {
    // "Add the sort code" is useless advice when two accounts could need it.
    const result = destinationsReadiness([
      complete("Main"),
      complete("Backup", { sort_code: null }),
    ]);
    expect(result.missing.every((m) => m.startsWith("Backup: "))).toBe(true);
  });

  it("does not prefix anything for a single-account borrower", () => {
    // Their experience must be identical to before multiple accounts existed.
    const result = destinationsReadiness([complete("Main", { sort_code: null })]);
    expect(result.missing).toEqual(["Add the sort code for where repayments are sent."]);
  });

  it("ignores an already-authorised account", () => {
    // Its details are fixed at the bank and cannot be edited, so reporting them
    // as missing would ask the operator to do something impossible.
    const result = destinationsReadiness([
      dest("Main", { account_number: null, sort_code: null }, { status: "authorized" }),
      complete("Backup"),
    ]);
    expect(result.ready).toBe(true);
  });

  it("ignores a retired account", () => {
    const result = destinationsReadiness([
      complete("Main"),
      dest("Old", { archived_at: "2026-08-01T00:00:00Z", account_number: null }, null),
    ]);
    expect(result.ready).toBe(true);
  });

  it("asks for a bank account when there are none", () => {
    const result = destinationsReadiness([]);
    expect(result.ready).toBe(false);
    expect(result.missing.join(" ")).toMatch(/add the bank account/i);
  });

  it("reports every incomplete account, not just the first", () => {
    const result = destinationsReadiness([
      complete("Main", { account_number: null }),
      complete("Backup", { sort_code: null }),
    ]);
    expect(result.missing.some((m) => m.startsWith("Main: "))).toBe(true);
    expect(result.missing.some((m) => m.startsWith("Backup: "))).toBe(true);
  });
});
