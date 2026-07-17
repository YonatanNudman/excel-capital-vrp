/** Domain-shaped types for our Plaid Payment Initiation / VRP usage. */

export interface RecipientInput {
  name: string;
  accountNumber?: string | null;
  sortCode?: string | null;
}

export interface ConsentConstraints {
  currency: string; // e.g. "GBP"
  maxPaymentAmountMinor?: number | null;
  period?: string | null; // "DAY" | "WEEK" | "MONTH" ...
  periodicAlignment?: string | null; // "CALENDAR" | "CONSENT"
  periodicMaxAmountMinor?: number | null;
  validFrom?: string | null; // ISO datetime
  validTo?: string | null; // ISO datetime
}

export interface CreateRecipientResult {
  recipientId: string;
}

export interface CreateConsentResult {
  consentId: string;
  rawConstraints: unknown;
}

export interface CreateLinkTokenResult {
  linkToken: string;
  expiration: string;
}

export interface ExecutePaymentInput {
  consentId: string;
  amountMinor: number;
  currency: string;
  reference: string;
  idempotencyKey: string;
}

export interface ExecutePaymentResult {
  paymentId: string;
  status: string; // raw Plaid status, e.g. PAYMENT_STATUS_INITIATED
}

export interface GetPaymentResult {
  paymentId: string;
  status: string;
}

export interface GetConsentResult {
  consentId: string;
  status: string; // e.g. AUTHORISED / REVOKED / EXPIRED
}

export interface WebhookVerification {
  verified: boolean;
  type: string | null;
  paymentId: string | null;
  newStatus: string | null;
  eventId: string | null;
}

/** The surface the rest of the app depends on. Real and Mock both implement it. */
export interface PlaidClient {
  readonly mode: "real" | "mock";
  createRecipient(input: RecipientInput): Promise<CreateRecipientResult>;
  createConsent(
    recipientId: string,
    reference: string,
    constraints: ConsentConstraints,
  ): Promise<CreateConsentResult>;
  createLinkToken(params: {
    consentId: string;
    borrowerId: string;
    webhookUrl?: string | null;
    redirectUri?: string | null;
  }): Promise<CreateLinkTokenResult>;
  getConsent(consentId: string): Promise<GetConsentResult>;
  executePayment(input: ExecutePaymentInput): Promise<ExecutePaymentResult>;
  getPayment(paymentId: string): Promise<GetPaymentResult>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookVerification>;
}
