import type { PlaidClient } from "./types";
import { MockPlaidClient } from "./mock";
import { RealPlaidClient } from "./real";

export * from "./types";
export { PlaidApiError, PlaidTransportError } from "./real";

/**
 * Return the real Plaid client when credentials are present, otherwise the mock.
 * This is the single switch that lets the whole app run end-to-end without real
 * Plaid credentials until Excel provides them, no code changes required to flip.
 */
export function getPlaidClient(env: {
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  APP_ENV?: string;
}): PlaidClient {
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    return new RealPlaidClient({
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      env: env.PLAID_ENV ?? "sandbox",
    });
  }
  // Fail closed in production: never silently fall back to the mock (which would
  // trust unauthenticated webhooks and "succeed" every payment).
  if (env.APP_ENV === "production") {
    throw new Error("Plaid credentials are required in production (mock client is not permitted)");
  }
  return new MockPlaidClient();
}

export function isPlaidConfigured(env: {
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
}): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}
