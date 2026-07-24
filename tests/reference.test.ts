import { describe, it, expect } from "vitest";
import { buildReference } from "@/lib/reference";

describe("buildReference", () => {
  it("substitutes tokens", () => {
    const ref = buildReference("EXCEL-{borrower}-{seq}", {
      borrowerToken: "ACME",
      seq: 3,
      date: "20260201",
    });
    expect(ref).toBe("EXCELACME3");
  });

  it("trims to Plaid's 18-char BACS limit", () => {
    const ref = buildReference("EXCELCAPITAL-{borrower}-{seq}", {
      borrowerToken: "LONGBORROWERNAME",
      seq: 12,
    });
    expect(ref.length).toBeLessThanOrEqual(18);
  });

  it("fills date when not provided", () => {
    const ref = buildReference("{date}", { borrowerToken: "X", seq: 1 });
    expect(ref).toMatch(/^\d{8}$/);
  });
});
