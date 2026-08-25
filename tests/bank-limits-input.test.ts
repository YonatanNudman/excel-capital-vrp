import { describe, it, expect } from "vitest";
import { parseBankAndLimits } from "@/lib/borrower-setup-input";

const valid = {
  recipientName: "Excel Capital Group Ltd",
  accountNumber: "12345678",
  sortCode: "12-34-56",
  maxPaymentAmount: "500",
  consentPeriod: "MONTH",
  periodicMaxAmount: "2000",
};

describe("parseBankAndLimits: happy path", () => {
  it("normalises a valid submission into minor units and bare digits", () => {
    const r = parseBankAndLimits(valid);
    expect(r.errors).toEqual([]);
    expect(r.value).toMatchObject({
      recipientName: "Excel Capital Group Ltd",
      accountNumber: "12345678",
      sortCode: "123456", // dashes stripped, as Plaid requires
      maxPaymentAmountMinor: 50_000,
      periodicMaxAmountMinor: 200_000,
      period: "MONTH",
    });
  });

  it("accepts a sort code written with & without spaces, slashes, or dashes", () => {
    for (const sortCode of ["12 34 56", "12/34/56", "123456", "12-34/56", "1234-56"]) {
      const r = parseBankAndLimits({ ...valid, sortCode });
      expect(r.errors).toEqual([]);
      expect(r.value?.sortCode).toBe("123456");
    }
  });

  it("handles pence correctly rather than rounding to pounds", () => {
    const r = parseBankAndLimits({ ...valid, maxPaymentAmount: "12.34" });
    expect(r.value?.maxPaymentAmountMinor).toBe(1234);
  });
});

describe("parseBankAndLimits: bank details", () => {
  it("rejects a sort code that is not six digits", () => {
    for (const sortCode of ["1234", "1234567", "ab-cd-ef", "12-34-e6"]) {
      const r = parseBankAndLimits({ ...valid, sortCode });
      expect(r.errors.join(" ")).toMatch(/sort code/i);
      expect(r.value).toBeUndefined();
    }
  });

  it("rejects an account number that is not eight digits", () => {
    for (const accountNumber of ["1234567", "123456789", "abcdefgh"]) {
      const r = parseBankAndLimits({ ...valid, accountNumber });
      expect(r.errors.join(" ")).toMatch(/account number/i);
    }
  });

  it("requires an account name", () => {
    const r = parseBankAndLimits({ ...valid, recipientName: "   " });
    expect(r.errors.join(" ")).toMatch(/name/i);
  });
});

describe("parseBankAndLimits: limits", () => {
  it("requires a per-payment cap above zero", () => {
    for (const maxPaymentAmount of ["", "0", "-5", "abc"]) {
      const r = parseBankAndLimits({ ...valid, maxPaymentAmount });
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("requires a periodic cap above zero", () => {
    const r = parseBankAndLimits({ ...valid, periodicMaxAmount: "0" });
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown period", () => {
    const r = parseBankAndLimits({ ...valid, consentPeriod: "FORTNIGHT" });
    expect(r.errors.join(" ")).toMatch(/period/i);
  });

  it("rejects a periodic cap below the per-payment cap", () => {
    // £2000 per payment but only £500 per month is incoherent: the first
    // payment could never be taken.
    const r = parseBankAndLimits({
      ...valid,
      maxPaymentAmount: "2000",
      periodicMaxAmount: "500",
    });
    expect(r.errors.join(" ")).toMatch(/per month|period.*less than|at least/i);
  });

  it("allows the periodic cap to equal the per-payment cap", () => {
    const r = parseBankAndLimits({
      ...valid,
      maxPaymentAmount: "500",
      periodicMaxAmount: "500",
    });
    expect(r.errors).toEqual([]);
  });
});

describe("parseBankAndLimits: error quality", () => {
  it("reports every problem at once, in plain language", () => {
    const r = parseBankAndLimits({
      recipientName: "",
      accountNumber: "1",
      sortCode: "2",
      maxPaymentAmount: "",
      consentPeriod: "",
      periodicMaxAmount: "",
    });
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
    for (const e of r.errors) {
      expect(e).not.toMatch(/minor|_|undefined|NaN/);
    }
  });
});
