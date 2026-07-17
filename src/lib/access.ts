/**
 * Cloudflare Access identity.
 *
 * Access authenticates the human at the edge and forwards the verified email in
 * the `Cf-Access-Authenticated-User-Email` header. In production the app sits
 * BEHIND Access, so this header is trustworthy. In local dev (no Access), we
 * fall back to a dev override header so the app is usable.
 *
 * Authorization (role) is looked up separately in the staff_users table.
 */

const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";
const DEV_EMAIL_HEADER = "x-dev-user-email";

export function getAuthenticatedEmail(
  headers: Headers,
  opts: { appEnv: string },
): string | null {
  const accessEmail = headers.get(ACCESS_EMAIL_HEADER);
  if (accessEmail) return accessEmail.toLowerCase();

  // Dev-only fallback so the app is testable before Access is configured.
  if (opts.appEnv !== "production") {
    const devEmail = headers.get(DEV_EMAIL_HEADER);
    if (devEmail) return devEmail.toLowerCase();
  }
  return null;
}
