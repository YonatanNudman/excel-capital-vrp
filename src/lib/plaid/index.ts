import type { PlaidClient } from "./types";
import { MockPlaidClient } from "./mock";
import { RealPlaidClient } from "./real";

export * from "./types";

/** Consent types Plaid accepts. Which one applies is Plaid's call per account. */
const VALID_CONSENT_TYPES = ["SWEEPING", "COMMERCIAL"];
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
  PLAID_CONSENT_TYPE?: string;
}): PlaidClient {
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    // Plaid confirmed on 2026-07-31 that this account is provisioned for
    // SWEEPING and that sweeping is the consent type they consider correct for
    // collecting scheduled loan repayments. COMMERCIAL returns
    // UNAUTHORIZED_ROUTE_ACCESS on this account.
    //
    // The guard is therefore not "which type", which is Plaid's call, but
    // "state it deliberately": an unknown value is always refused, and
    // production must set it explicitly rather than inherit a default, so
    // nobody goes live on a guess.
    const raw = env.PLAID_CONSENT_TYPE?.trim().toUpperCase();
    if (env.APP_ENV === "production" && !raw) {
      throw new Error(
        "PLAID_CONSENT_TYPE must be set explicitly in production (SWEEPING or COMMERCIAL)",
      );
    }
    const consentType = raw || "SWEEPING";
    if (!VALID_CONSENT_TYPES.includes(consentType)) {
      throw new Error(
        `PLAID_CONSENT_TYPE must be one of ${VALID_CONSENT_TYPES.join(", ")} (got ${consentType})`,
      );
    }
    return new RealPlaidClient({
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      env: env.PLAID_ENV ?? "sandbox",
      consentType,
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
