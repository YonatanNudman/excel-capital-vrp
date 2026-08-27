import { describe, it, expect } from "vitest";
import {
  CompaniesHouseError,
  companiesHouseFailureMessage,
} from "@/lib/companies-house";

/**
 * Every failure used to read "Could not reach Companies House. Try again, or
 * type the details in by hand."
 *
 * For a rejected API key that is actively wrong on both halves: retrying never
 * works, and typing the company in by hand produces exactly the unverified
 * borrower record the register check exists to prevent.
 */
describe("companiesHouseFailureMessage", () => {
  const msg = (status?: number) =>
    companiesHouseFailureMessage(new CompaniesHouseError("failed", status));

  it("does not invite a retry when the key is rejected", () => {
    for (const status of [401, 403]) {
      const m = msg(status);
      expect(m).toMatch(/key/i);
      expect(m).not.toMatch(/try again/i);
    }
  });

  it("tells staff NOT to type it in by hand when the key is rejected", () => {
    // Hand-typing is the failure mode with real consequences: an unverified
    // company on a lender's books.
    expect(msg(401)).toMatch(/do not type/i);
  });

  it("invites a retry for rate limiting, which does pass", () => {
    expect(msg(429)).toMatch(/again/i);
  });

  it("invites a retry when Companies House is down", () => {
    expect(msg(503)).toMatch(/again/i);
    expect(msg(500)).toMatch(/their end/i);
  });

  it("says not found rather than blaming the connection", () => {
    expect(msg(404)).toMatch(/no company found/i);
  });

  it("falls back to the old wording when there is no status", () => {
    expect(msg(undefined)).toMatch(/could not reach/i);
    expect(companiesHouseFailureMessage(new Error("boom"))).toMatch(/could not reach/i);
  });
});

describe("failures that never reached Companies House", () => {
  /**
   * The only path that produces a CompaniesHouseError with NO http status is the
   * fetch itself failing. That covers a timeout, a DNS failure and an API key so
   * malformed it cannot even be encoded into an auth header. Staff saw one
   * identical sentence for all of them, and so did we.
   */
  it("names a timeout as a timeout", () => {
    const m = companiesHouseFailureMessage(
      new CompaniesHouseError("The operation was aborted due to timeout"),
    );
    expect(m).toMatch(/did not respond in time/i);
  });

  it("carries the underlying reason through for anything else", () => {
    const m = companiesHouseFailureMessage(
      new CompaniesHouseError("InvalidCharacterError"),
    );
    expect(m).toMatch(/InvalidCharacterError/);
  });

  it("still has a plain fallback when there is no detail at all", () => {
    expect(companiesHouseFailureMessage({})).toMatch(/could not reach/i);
  });
});
