import type { EmailMessage, Mailer, MailerResult } from "./types";

/**
 * Sends real email via the Resend HTTP API. Activated only when both
 * RESEND_API_KEY and EMAIL_FROM are configured (see getMailer). It never throws:
 * any transport, HTTP, or parsing error is caught and returned as
 * { ok: false, error }, so a mail failure can never abort a payment or webhook.
 */
export class ResendMailer implements Mailer {
  readonly mode = "resend" as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    /**
     * Where borrower replies should land. Without it, a borrower answering a
     * payment receipt writes into a no-reply void and nobody at the lender ever
     * sees it.
     */
    private readonly replyTo?: string,
  ) {}

  async send(msg: EmailMessage): Promise<MailerResult> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
      });

      if (res.status >= 200 && res.status < 300) return { ok: true };

      // Surface the provider's error text (truncated) for the audit trail, but
      // do not throw: the caller decides how to record a non-delivery.
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      return { ok: false, error: `resend ${res.status}: ${detail}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
