import { describe, it, expect } from "vitest";
import {
  mapPlaidStatus,
  canTransition,
  IN_FLIGHT_OR_DONE,
  RETRY_ELIGIBLE,
} from "@/lib/payment-state";

describe("mapPlaidStatus", () => {
  // Scenario eval #2: INITIATED is treated as submitted-success, not failure.
  it("maps PAYMENT_STATUS_INITIATED to internal 'initiated' (submitted, not failed)", () => {
    const s = mapPlaidStatus("PAYMENT_STATUS_INITIATED");
    expect(s).toBe("initiated");
    expect(s && IN_FLIGHT_OR_DONE.has(s)).toBe(true);
    expect(s && RETRY_ELIGIBLE.has(s)).toBe(false);
  });

  it("maps settlement and execution correctly", () => {
    expect(mapPlaidStatus("PAYMENT_STATUS_EXECUTED")).toBe("executed");
    expect(mapPlaidStatus("PAYMENT_STATUS_SETTLED")).toBe("settled");
  });

  // Scenario eval #3: failures are retry-eligible.
  it("maps insufficient funds / failed to retry-eligible 'failed'", () => {
    expect(mapPlaidStatus("PAYMENT_STATUS_INSUFFICIENT_FUNDS")).toBe("failed");
    expect(mapPlaidStatus("PAYMENT_STATUS_FAILED")).toBe("failed");
    expect(RETRY_ELIGIBLE.has("failed")).toBe(true);
  });

  it("maps rejected/blocked/cancelled and returns null for unknown", () => {
    expect(mapPlaidStatus("PAYMENT_STATUS_REJECTED")).toBe("rejected");
    expect(mapPlaidStatus("PAYMENT_STATUS_BLOCKED")).toBe("failed");
    expect(mapPlaidStatus("PAYMENT_STATUS_CANCELLED")).toBe("cancelled");
    expect(mapPlaidStatus("SOMETHING_NEW")).toBeNull();
  });
});

describe("canTransition (out-of-order / duplicate webhook guard)", () => {
  it("allows forward progress", () => {
    expect(canTransition("submitted", "initiated")).toBe(true);
    expect(canTransition("initiated", "executed")).toBe(true);
    expect(canTransition("executed", "settled")).toBe(true);
  });

  // Scenario eval #5 (part): a duplicate webhook is a no-op.
  it("rejects same-state (duplicate webhook)", () => {
    expect(canTransition("initiated", "initiated")).toBe(false);
    expect(canTransition("settled", "settled")).toBe(false);
  });

  it("never leaves a terminal state (late 'failed' after 'settled' is ignored)", () => {
    expect(canTransition("settled", "failed")).toBe(false);
    expect(canTransition("rejected", "initiated")).toBe(false);
    expect(canTransition("cancelled", "executed")).toBe(false);
  });

  it("does not regress to a lower-progress status", () => {
    expect(canTransition("executed", "initiated")).toBe(false);
    expect(canTransition("initiated", "submitted")).toBe(false);
  });
});
