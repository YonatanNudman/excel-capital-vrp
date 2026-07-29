/* eslint-disable @typescript-eslint/no-unused-vars -- fixtures are destructured to OMIT fields on purpose */
import { describe, it, expect, afterEach, vi } from "vitest";
import { RealPlaidClient } from "@/lib/plaid/real";
import { getPlaidClient } from "@/lib/plaid";
import type { ConsentConstraints } from "@/lib/plaid/types";

/**
 * These assert the exact wire shape Plaid expects for a UK VRP consent.
 * The mock client accepts anything, so only tests like these (or a live call)
 * catch a wrong field name. Reference:
 * https://plaid.com/docs/api/products/payment-initiation/ consent/create
 */

const client = new RealPlaidClient({ clientId: "cid", secret: "sec", env: "sandbox" });

const fullConstraints: ConsentConstraints = {
  currency: "GBP",
  maxPaymentAmountMinor: 50_000, // £500.00
  periodicMaxAmountMinor: 200_000, // £2000.00
  period: "MONTH",
  periodicAlignment: "CALENDAR",
  validFrom: "2026-07-29T00:00:00Z",
  validTo: "2027-07-29T00:00:00Z",
};

/** Capture the outgoing request body, return a canned success. */
function captureFetch(response: Record<string, unknown> = { consent_id: "consent-123" }) {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return {
    body: () => JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string),
    url: () => spy.mock.calls[0][0] as string,
    calls: () => spy.mock.calls.length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createConsent wire format", () => {
  it("sends max_payment_amount, the field Plaid actually accepts", async () => {
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", fullConstraints);

    const constraints = cap.body().constraints;
    expect(constraints.max_payment_amount).toEqual({ currency: "GBP", value: 500 });
    // Plaid rejects the whole request with UNKNOWN_FIELDS if this reappears.
    expect(constraints).not.toHaveProperty("max_individual_amount");
  });

  it("converts minor units to Plaid's major-unit decimals", async () => {
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", {
      ...fullConstraints,
      maxPaymentAmountMinor: 1_234, // £12.34
      periodicMaxAmountMinor: 99, // £0.99
    });

    const constraints = cap.body().constraints;
    expect(constraints.max_payment_amount.value).toBe(12.34);
    expect(constraints.periodic_amounts[0].amount.value).toBe(0.99);
  });

  it("sends periodic_amounts with interval and alignment", async () => {
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", fullConstraints);

    expect(cap.body().constraints.periodic_amounts).toEqual([
      { amount: { currency: "GBP", value: 2000 }, interval: "MONTH", alignment: "CALENDAR" },
    ]);
  });

  it("sends valid_date_time when a window is configured", async () => {
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", fullConstraints);

    expect(cap.body().constraints.valid_date_time).toEqual({
      from: "2026-07-29T00:00:00.000Z",
      to: "2027-07-29T00:00:00.000Z",
    });
  });

  it("normalises a datetime-local value to RFC 3339", async () => {
    // <input type="datetime-local"> yields "2027-07-29T00:00": no seconds and
    // no offset. Plaid rejects that with INVALID_FIELD, so normalise it here.
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", {
      ...fullConstraints,
      validFrom: "2026-07-29T09:30",
      validTo: "2027-07-29T00:00",
    });

    const window = cap.body().constraints.valid_date_time;
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    expect(window.from).toMatch(rfc3339);
    expect(window.to).toMatch(rfc3339);
    expect(Number.isNaN(Date.parse(window.to))).toBe(false);
  });

  it("omits valid_date_time entirely when no window is configured", async () => {
    const cap = captureFetch();
    const { validFrom: _a, validTo: _b, ...noWindow } = fullConstraints;
    await client.createConsent("recipient-1", "EXCELCAP", noWindow as ConsentConstraints);

    expect(cap.body().constraints).not.toHaveProperty("valid_date_time");
  });

  it("rejects an unparseable datetime instead of sending it to Plaid", async () => {
    const cap = captureFetch();
    await expect(
      client.createConsent("recipient-1", "EXCELCAP", {
        ...fullConstraints,
        validTo: "not-a-date",
      }),
    ).rejects.toThrow(/datetime/i);
    expect(cap.calls()).toBe(0);
  });

  it("posts to the sandbox host with credentials and the recipient", async () => {
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", fullConstraints);

    expect(cap.url()).toBe("https://sandbox.plaid.com/payment_initiation/consent/create");
    const body = cap.body();
    expect(body.client_id).toBe("cid");
    expect(body.secret).toBe("sec");
    expect(body.recipient_id).toBe("recipient-1");
    expect(body.reference).toBe("EXCELCAP");
  });
});

describe("createConsent required-constraint validation", () => {
  it("refuses locally when the per-payment cap is missing, without calling Plaid", async () => {
    const cap = captureFetch();
    const { maxPaymentAmountMinor: _omitted, ...withoutMax } = fullConstraints;

    await expect(
      client.createConsent("recipient-1", "EXCELCAP", withoutMax as ConsentConstraints),
    ).rejects.toThrow(/max.*payment amount|per-payment/i);
    expect(cap.calls()).toBe(0);
  });

  it("refuses locally when the periodic cap is missing, without calling Plaid", async () => {
    const cap = captureFetch();
    const { periodicMaxAmountMinor: _a, period: _b, ...withoutPeriodic } = fullConstraints;

    await expect(
      client.createConsent("recipient-1", "EXCELCAP", withoutPeriodic as ConsentConstraints),
    ).rejects.toThrow(/periodic/i);
    expect(cap.calls()).toBe(0);
  });
});

describe("consent type selection", () => {
  it("defaults to COMMERCIAL, the type this product actually needs", async () => {
    const cap = captureFetch();
    await client.createConsent("recipient-1", "EXCELCAP", fullConstraints);
    expect(cap.body().type).toBe("COMMERCIAL");
  });

  it("can be set to SWEEPING for sandbox while Plaid entitlement is pending", async () => {
    const cap = captureFetch();
    const sweeping = new RealPlaidClient({
      clientId: "cid",
      secret: "sec",
      env: "sandbox",
      consentType: "SWEEPING",
    });
    await sweeping.createConsent("recipient-1", "EXCELCAP", fullConstraints);
    expect(cap.body().type).toBe("SWEEPING");
  });
});

describe("getPlaidClient consent-type guard", () => {
  const base = { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_ENV: "sandbox" };

  it("refuses a non-commercial consent type in production", () => {
    expect(() =>
      getPlaidClient({ ...base, APP_ENV: "production", PLAID_CONSENT_TYPE: "SWEEPING" }),
    ).toThrow(/COMMERCIAL in production/);
  });

  it("allows SWEEPING outside production", () => {
    expect(() =>
      getPlaidClient({ ...base, APP_ENV: "staging", PLAID_CONSENT_TYPE: "SWEEPING" }),
    ).not.toThrow();
  });

  it("allows production when the type is commercial", () => {
    expect(() =>
      getPlaidClient({ ...base, APP_ENV: "production", PLAID_CONSENT_TYPE: "COMMERCIAL" }),
    ).not.toThrow();
  });
});
