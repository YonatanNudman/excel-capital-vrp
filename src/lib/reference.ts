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
  const safe = ref.replace(/[^a-zA-Z0-9]/g, "");
  if (!safe) throw new Error("payment reference must contain letters or numbers");
  return safe.slice(0, 18);
}

export function buildUniqueReference(
  template: string,
  opts: { borrowerToken: string; seq: number; date?: string },
  idempotencyKey: string,
): string {
  return uniqueReferenceFromBase(buildReference(template, opts), idempotencyKey);
}

export function uniqueReferenceFromBase(base: string, idempotencyKey: string): string {
  const suffix = shortHash(idempotencyKey).slice(0, 6).toUpperCase();
  const safe = base.replace(/[^a-zA-Z0-9]/g, "");
  if (!safe) throw new Error("payment reference must contain letters or numbers");
  return `${safe.slice(0, 12)}${suffix}`;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0");
}
