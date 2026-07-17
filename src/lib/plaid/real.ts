import type {
  PlaidClient,
  RecipientInput,
  ConsentConstraints,
  CreateRecipientResult,
  CreateConsentResult,
  CreateLinkTokenResult,
  ExecutePaymentResult,
  ExecutePaymentInput,
  GetPaymentResult,
  GetConsentResult,
  WebhookVerification,
} from "./types";

const BASE_URLS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface RealPlaidConfig {
  clientId: string;
  secret: string;
  env: string; // "sandbox" | "production"
  /**
   * VRP consent scope. Borrower-to-lender is a third-party arrangement; the
   * exact scope value MUST be confirmed against Excel's Plaid setup before
   * go-live. Defaulted, not guessed as final.
   */
  scope?: string;
}

/**
 * Real Plaid Payment Initiation / VRP client via fetch (Workers-native).
 *
 * NOTE: This has not been exercised against a live Plaid account yet. Every
 * request/response shape follows Plaid's documented Payment Initiation API, but
 * validate end-to-end in sandbox once credentials arrive. Amounts are sent as
 * major-unit decimals (Plaid's format); we store minor units internally.
 */
export class RealPlaidClient implements PlaidClient {
  readonly mode = "real" as const;
  private base: string;

  constructor(private cfg: RealPlaidConfig) {
    this.base = BASE_URLS[cfg.env] ?? BASE_URLS.sandbox;
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        secret: this.cfg.secret,
        ...body,
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = json as { error_code?: string; error_message?: string };
      throw new PlaidApiError(
        err.error_code ?? "PLAID_ERROR",
        err.error_message ?? `HTTP ${res.status}`,
        res.status,
      );
    }
    return json as T;
  }

  async createRecipient(input: RecipientInput): Promise<CreateRecipientResult> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.accountNumber && input.sortCode) {
      body.bacs = { account: input.accountNumber, sort_code: input.sortCode };
    }
    const r = await this.call<{ recipient_id: string }>(
      "/payment_initiation/recipient/create",
      body,
    );
    return { recipientId: r.recipient_id };
  }

  async createConsent(
    recipientId: string,
    reference: string,
    constraints: ConsentConstraints,
  ): Promise<CreateConsentResult> {
    const plaidConstraints: Record<string, unknown> = {};
    if (constraints.validFrom || constraints.validTo) {
      plaidConstraints.valid_date_time = {
        from: constraints.validFrom ?? undefined,
        to: constraints.validTo ?? undefined,
      };
    }
    if (constraints.maxPaymentAmountMinor != null) {
      plaidConstraints.max_individual_amount = {
        currency: constraints.currency,
        value: minorToMajor(constraints.maxPaymentAmountMinor),
      };
    }
    if (constraints.periodicMaxAmountMinor != null && constraints.period) {
      plaidConstraints.periodic_amounts = [
        {
          amount: {
            currency: constraints.currency,
            value: minorToMajor(constraints.periodicMaxAmountMinor),
          },
          interval: constraints.period,
          alignment: constraints.periodicAlignment ?? "CALENDAR",
        },
      ];
    }

    const r = await this.call<{ consent_id: string }>(
      "/payment_initiation/consent/create",
      {
        recipient_id: recipientId,
        reference,
        scopes: [this.cfg.scope ?? "ME_TO_ME"],
        constraints: plaidConstraints,
      },
    );
    return { consentId: r.consent_id, rawConstraints: plaidConstraints };
  }

  async createLinkToken(params: {
    consentId: string;
    borrowerId: string;
    webhookUrl?: string | null;
    redirectUri?: string | null;
  }): Promise<CreateLinkTokenResult> {
    const body: Record<string, unknown> = {
      user: { client_user_id: params.borrowerId },
      client_name: "Excel Capital",
      products: ["payment_initiation"],
      country_codes: ["GB"],
      language: "en",
      payment_initiation: { consent_id: params.consentId },
    };
    if (params.webhookUrl) body.webhook = params.webhookUrl;
    if (params.redirectUri) body.redirect_uri = params.redirectUri;

    const r = await this.call<{ link_token: string; expiration: string }>(
      "/link/token/create",
      body,
    );
    return { linkToken: r.link_token, expiration: r.expiration };
  }

  async getConsent(consentId: string): Promise<GetConsentResult> {
    const r = await this.call<{ status: string }>("/payment_initiation/consent/get", {
      consent_id: consentId,
    });
    return { consentId, status: r.status };
  }

  async executePayment(input: ExecutePaymentInput): Promise<ExecutePaymentResult> {
    const r = await this.call<{ payment_id: string; status: string }>(
      "/payment_initiation/consent/payment/execute",
      {
        consent_id: input.consentId,
        amount: { currency: input.currency, value: minorToMajor(input.amountMinor) },
        idempotency_key: input.idempotencyKey,
        reference: input.reference,
      },
    );
    return { paymentId: r.payment_id, status: r.status };
  }

  async getPayment(paymentId: string): Promise<GetPaymentResult> {
    const r = await this.call<{ status: string }>("/payment_initiation/payment/get", {
      payment_id: paymentId,
    });
    return { paymentId, status: r.status };
  }

  /**
   * Verify a Plaid webhook. Plaid signs the body with a JWT in the
   * `plaid-verification` header (ES256); the JWT's `request_body_sha256` claim
   * must match the SHA-256 of the raw body. The verification key is fetched from
   * /webhook_verification_key/get and cached by the caller if desired.
   *
   * MUST be validated against sandbox before relying on it in production.
   */
  async verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookVerification> {
    const empty: WebhookVerification = {
      verified: false,
      type: null,
      paymentId: null,
      newStatus: null,
      eventId: null,
    };
    const token = headers.get("plaid-verification");
    if (!token) return empty;

    try {
      const [headerB64, payloadB64, sigB64] = token.split(".");
      const header = JSON.parse(b64urlToText(headerB64)) as { kid: string; alg: string };
      if (header.alg !== "ES256") return empty;

      const keyRes = await this.call<{ key: JsonWebKey }>(
        "/webhook_verification_key/get",
        { key_id: header.kid },
      );
      const key = await crypto.subtle.importKey(
        "jwk",
        keyRes.key,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const signed = toArrayBuffer(new TextEncoder().encode(`${headerB64}.${payloadB64}`));
      const sig = toArrayBuffer(b64urlToBytes(sigB64));
      const ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        sig,
        signed,
      );
      if (!ok) return empty;

      const claims = JSON.parse(b64urlToText(payloadB64)) as {
        request_body_sha256?: string;
      };
      const bodyHash = await sha256HexLocal(rawBody);
      if (claims.request_body_sha256 && claims.request_body_sha256 !== bodyHash) {
        return empty;
      }

      const parsed = JSON.parse(rawBody) as {
        payment_id?: string;
        new_payment_status?: string;
        webhook_type?: string;
        event_id?: string;
      };
      return {
        verified: true,
        type: parsed.webhook_type ?? null,
        paymentId: parsed.payment_id ?? null,
        newStatus: parsed.new_payment_status ?? null,
        eventId: parsed.event_id ?? parsed.payment_id ?? null,
      };
    } catch {
      return empty;
    }
  }
}

export class PlaidApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number,
  ) {
    super(message);
  }
}

function minorToMajor(minor: number): number {
  return Number((minor / 100).toFixed(2));
}

function b64urlToText(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
async function sha256HexLocal(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", toArrayBuffer(new TextEncoder().encode(input)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
