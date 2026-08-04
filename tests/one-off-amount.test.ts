import { describe, it, expect } from "vitest";
import { checkAmountAgainstConsent } from "@/lib/payment-limits";
import type { Consent } from "@/lib/types";

const consent = (over: Partial<Consent> = {}): Consent =>
  ({
    id: "con1",
    borrower_id: "bor1",
    plaid_consent_id: null,
    plaid_consent_id_hash: null,
    plaid_recipient_id: null,
    status: "authorized",
    currency: "GBP",
    max_payment_amount_minor: 50_000, // £500
    period: "MONTH",
    periodic_alignment: "CALENDAR",
    periodic_max_amount_minor: 200_000, // £2000
    valid_from: null,
    valid_to: null,
    authorized_at: null,
    ...over,
  }) as Consent;

describe("checkAmountAgainstConsent", () => {
  it("allows an amount within the per-payment cap", () => {
    expect(checkAmountAgainstConsent(25_000, consent())).toBeNull();
  });

  it("allows an amount exactly at the cap", () => {
    expect(checkAmountAgainstConsent(50_000, consent())).toBeNull();
  });

  /**
   * The bank enforces this too, so without a local check the operator would see
   * a confusing provider rejection after the payment had already been created.
   */
  it("refuses an amount above the per-payment cap, quoting both figures", () => {
    const error = checkAmountAgainstConsent(75_000, consent());
    expect(error).toMatch(/£750\.00/);
    expect(error).toMatch(/£500\.00/);
    expect(error).toMatch(/agreed|limit/i);
  });

  it("mentions that a new authorisation is the way to raise the limit", () => {
    const error = checkAmountAgainstConsent(75_000, consent());
    expect(error).toMatch(/setup link|authoris/i);
  });

  it("refuses when there is no consent at all", () => {
    expect(checkAmountAgainstConsent(1_000, null)).toMatch(/not.*authoris|no.*authoris/i);
  });

  it("refuses when the consent is not authorised yet", () => {
    expect(checkAmountAgainstConsent(1_000, consent({ status: "pending" }))).toMatch(
      /not.*authoris/i,
    );
  });

  it("refuses a revoked consent", () => {
    expect(checkAmountAgainstConsent(1_000, consent({ status: "revoked" }))).toMatch(
      /not.*authoris/i,
    );
  });

  it("allows any amount when no per-payment cap is recorded, leaving it to the bank", () => {
    // Should not happen for a consent that reached authorised, but guessing a
    // cap here would be worse than deferring to the provider.
    expect(checkAmountAgainstConsent(999_999, consent({ max_payment_amount_minor: null }))).toBeNull();
  });

  it("refuses a zero or negative amount", () => {
    expect(checkAmountAgainstConsent(0, consent())).toMatch(/amount/i);
    expect(checkAmountAgainstConsent(-500, consent())).toMatch(/amount/i);
  });
});
