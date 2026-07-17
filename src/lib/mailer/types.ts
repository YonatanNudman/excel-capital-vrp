/** Email notification primitives. Kept tiny and framework-free so engines and
 *  server actions can depend on the Mailer interface without pulling in Next.js. */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailerResult = { ok: boolean; error?: string };

export interface Mailer {
  readonly mode: "log" | "resend";
  send(msg: EmailMessage): Promise<MailerResult>;
}
