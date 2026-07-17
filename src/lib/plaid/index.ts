import type { PlaidClient } from "./types";
import { MockPlaidClient } from "./mock";
import { RealPlaidClient } from "./real";

export * from "./types";
export { PlaidApiError } from "./real";

/**
 * Return the real Plaid client when credentials are present, otherwise the mock.
 * This is the single switch that lets the whole app run end-to-end without real
 * Plaid credentials until Excel provides them — no code changes required to flip.
 */
export function getPlaidClient(env: {
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  PLAID_SCOPE?: string;
}): PlaidClient {
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    return new RealPlaidClient({
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      env: env.PLAID_ENV ?? "sandbox",
      scope: env.PLAID_SCOPE,
    });
  }
  return new MockPlaidClient();
}

export function isPlaidConfigured(env: {
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
}): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}
