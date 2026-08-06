import type { MailerEnv } from "./index";

/**
 * How far outbound email actually reaches. Distinct from "is a mailer
 * configured", because Resend's shared test sender looks configured while
 * delivering to nobody except the Resend account owner.
 *
 *  off        no sending configured; nothing leaves the app
 *  owner-only the resend.dev test sender: admin notices arrive, borrower
 *             email is rejected with a 403
 *  live       a verified domain; borrowers receive email
 */
export type EmailReach = "off" | "owner-only" | "live";

/** Resend's shared sender, usable without verifying a domain. */
const TEST_SENDER_DOMAIN = "resend.dev";

export function emailReach(env: MailerEnv): EmailReach {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!key || !from) return "off";

  // Match the domain of the address itself, so an unrelated host that merely
  // contains the string is not mistaken for the test sender.
  const address = from.includes("<") ? from.slice(from.indexOf("<") + 1, from.indexOf(">")) : from;
  const domain = address.split("@").pop()?.trim().toLowerCase() ?? "";
  return domain === TEST_SENDER_DOMAIN ? "owner-only" : "live";
}
