import { webhookDeliveryId } from "./delivery-id";
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

/**
 * Deterministic mock used when Plaid credentials are absent (local dev, tests,
 * and pre-integration stages). It mimics the shape and the important behaviours
 * of Plaid VRP so the entire flow, setup, consent, execute, webhook, is
 * exercisable end-to-end without real credentials.
 *
 * Behaviour: executePayment returns PAYMENT_STATUS_INITIATED (the realistic
 * Faster Payments "submitted" signal). getPayment reports SETTLED so a polling
 * or cron reconciliation path can complete in dev.
 */
export class MockPlaidClient implements PlaidClient {
  readonly mode = "mock" as const;

  async createRecipient(input: RecipientInput): Promise<CreateRecipientResult> {
    return { recipientId: `mock-recipient-${hash(input.name)}` };
  }

  async createConsent(
    recipientId: string,
    reference: string,
    constraints: ConsentConstraints,
  ): Promise<CreateConsentResult> {
    return {
      consentId: `mock-consent-${hash(recipientId + reference)}`,
      rawConstraints: constraints,
    };
  }

  async createLinkToken(params: {
    consentId: string;
  }): Promise<CreateLinkTokenResult> {
    return {
      linkToken: `mock-link-token-${params.consentId}`,
      expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  async getConsent(consentId: string): Promise<GetConsentResult> {
    return { consentId, status: "AUTHORISED" };
  }

  async executePayment(input: ExecutePaymentInput): Promise<ExecutePaymentResult> {
    return {
      paymentId: `mock-payment-${hash(input.idempotencyKey)}`,
      status: "PAYMENT_STATUS_INITIATED",
    };
  }

  async getPayment(paymentId: string): Promise<GetPaymentResult> {
    return { paymentId, status: "PAYMENT_STATUS_SETTLED" };
  }

  async verifyWebhook(rawBody: string): Promise<WebhookVerification> {
    // In mock mode we trust the body (no signing key). Shape mirrors the real path.
    try {
      const parsed = JSON.parse(rawBody) as {
        payment_id?: string;
        new_payment_status?: string;
        webhook_type?: string;
        event_id?: string;
        timestamp?: string;
      };
      return {
        verified: true,
        type: parsed.webhook_type ?? "PAYMENT_INITIATION",
        paymentId: parsed.payment_id ?? null,
        newStatus: parsed.new_payment_status ?? null,
        eventId: webhookDeliveryId(parsed),
      };
    } catch {
      return { verified: false, type: null, paymentId: null, newStatus: null, eventId: null };
    }
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
