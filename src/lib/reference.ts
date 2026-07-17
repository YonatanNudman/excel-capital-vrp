/**
 * Build a payment reference from the configurable template.
 * Supported tokens: {borrower} {seq} {date}. Result is trimmed to Plaid's
 * 18-char BACS reference limit.
 */
export function buildReference(
  template: string,
  opts: { borrowerToken: string; seq: number; date?: string },
): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ref = template
    .replace(/\{borrower\}/g, opts.borrowerToken)
    .replace(/\{seq\}/g, String(opts.seq))
    .replace(/\{date\}/g, date);
  return ref.slice(0, 18);
}
