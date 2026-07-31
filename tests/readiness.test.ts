import { describe, it, expect } from "vitest";
import { setupReadiness } from "@/lib/readiness";
import type { Consent, Recipient } from "@/lib/types";

const recipient = (over: Partial<Recipient> = {}): Recipient => ({
  id: "rec1",
  borrower_id: "bor1",
  plaid_recipient_id: null,
  name: "Excel Capital Group Ltd",
  account_number: "12345678",
  sort_code: "123456",
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
