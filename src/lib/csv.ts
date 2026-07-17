/**
 * CSV cell escape: wraps in quotes and doubles embedded quotes. Cells starting
 * with = + - @ or tab/CR are prefixed with a single quote so spreadsheet apps
 * never evaluate operator-influenced text (borrower names, references) as
 * formulas when staff open an export.
 */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
