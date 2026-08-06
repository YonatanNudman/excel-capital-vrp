import type { Mailer } from "./types";
import { LogMailer } from "./log";
import { ResendMailer } from "./resend";

export * from "./types";
export { LogMailer } from "./log";
export { ResendMailer } from "./resend";

/**
 * Environment shape the mailer needs. Typed structurally (not via CloudflareEnv)
 * because RESEND_API_KEY / EMAIL_FROM are added to secrets separately and are not
 * part of the generated binding types.
 */
export interface MailerEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Where replies go. Optional; omitted from the send when unset. */
  EMAIL_REPLY_TO?: string;
}

/**
 * Single switch for outbound email: use Resend only when both the API key and a
 * verified from-address are present, otherwise fall back to the no-send LogMailer.
 * This lets the whole app run (and be tested) with no sending domain, and flip to
 * real delivery with zero code changes once the secrets are set.
 */
export function getMailer(env: MailerEnv): Mailer {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    return new ResendMailer(
      env.RESEND_API_KEY,
      env.EMAIL_FROM,
      env.EMAIL_REPLY_TO?.trim() || undefined,
    );
  }
  return new LogMailer();
}
