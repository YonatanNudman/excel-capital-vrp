import { describe, it, expect } from "vitest";
import { csvCell } from "@/lib/csv";

describe("csvCell", () => {
  it("quotes plain values and doubles embedded quotes", () => {
    expect(csvCell("Acme Ltd")).toBe('"Acme Ltd"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell(null)).toBe('""');
  });

  it("neutralises spreadsheet formula prefixes", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+SUM(A1)")).toBe("\"'+SUM(A1)\"");
    expect(csvCell("-2+3")).toBe("\"'-2+3\"");
    expect(csvCell("@cmd")).toBe("\"'@cmd\"");
  });

  it("leaves normal negative-looking references intact only when not leading", () => {
    expect(csvCell("EXCEL-09876543-1")).toBe('"EXCEL-09876543-1"');
  });
});
