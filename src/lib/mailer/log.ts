import type { EmailMessage, Mailer, MailerResult } from "./types";

/**
 * Default mailer used until a sending domain is configured. It records that an
 * email would have been sent without ever transmitting it, and deliberately logs
 * only recipient and subject (never the body) so borrower content is not written
 * into Workers logs. Always reports success so callers treat it as delivered.
 */
export class LogMailer implements Mailer {
  readonly mode = "log" as const;

  async send(msg: EmailMessage): Promise<MailerResult> {
    console.log(`[mailer:log] would send to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
    return { ok: true };
  }
}
