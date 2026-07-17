import { describe, it, expect } from "vitest";
import { scheduledKey, retryKey, manualKey } from "@/lib/idempotency";

// Scenario eval #1: the same scheduled payment triggered twice yields the SAME
// key, so the DB UNIQUE constraint blocks the second attempt (no double-collect).
describe("scheduledKey", () => {
  it("is deterministic for the same borrower/schedule/due-date", () => {
    const a = scheduledKey("b1", "s1", "2026-02-01");
    const b = scheduledKey("b1", "s1", "2026-02-01");
    expect(a).toBe(b);
  });
  it("differs across due dates and borrowers", () => {
    expect(scheduledKey("b1", "s1", "2026-02-01")).not.toBe(scheduledKey("b1", "s1", "2026-03-01"));
    expect(scheduledKey("b1", "s1", "2026-02-01")).not.toBe(scheduledKey("b2", "s1", "2026-02-01"));
  });
});

// Scenario eval #3: a genuine retry is a DISTINCT attempt (new key allowed).
describe("retryKey", () => {
  it("differs per attempt but is stable within an attempt", () => {
    expect(retryKey("p1", 1)).toBe(retryKey("p1", 1));
    expect(retryKey("p1", 1)).not.toBe(retryKey("p1", 2));
  });
  it("rejects attempt < 1", () => {
    expect(() => retryKey("p1", 0)).toThrow();
  });
});

describe("manualKey", () => {
  it("is unique per nonce", () => {
    expect(manualKey("b1", "n1")).not.toBe(manualKey("b1", "n2"));
  });
});
