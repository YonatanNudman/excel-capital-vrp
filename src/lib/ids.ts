/** UUID generation (Web Crypto is available in the Workers runtime). */
export function newId(): string {
  return crypto.randomUUID();
}
