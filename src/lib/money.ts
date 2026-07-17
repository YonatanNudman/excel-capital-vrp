/**
 * Money helpers. All amounts are integer minor units (pence for GBP). Never floats.
 */

export function toMinorUnits(major: number): number {
  // Rounds to nearest minor unit; guards against float artefacts (e.g. 1.1 * 100).
  return Math.round(major * 100);
}

export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

/** Format minor units for display, e.g. 12345 -> "£123.45". */
export function formatMinor(minor: number, currency = "GBP"): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(minor / 100);
}
