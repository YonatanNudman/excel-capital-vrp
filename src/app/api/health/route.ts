import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuthenticatedEmail } from "@/lib/access";

export const dynamic = "force-dynamic";

/**
 * Health check: proves the Worker runtime, env vars, D1 binding, and Access
 * identity plumbing are all wired. Returns non-sensitive status only.
 */
export async function GET(request: Request) {
  const { env } = getCloudflareContext();
  const appEnv = env.APP_ENV ?? "unknown";

  let db: "ok" | "error" = "error";
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    db = row?.ok === 1 ? "ok" : "error";
  } catch {
    db = "error";
  }

  const email = getAuthenticatedEmail(request.headers, { appEnv });

  return Response.json({
    ok: db === "ok",
    appEnv,
    plaidEnv: env.PLAID_ENV ?? "unknown",
    db,
    authenticatedEmail: email, // null until Access is in front (or dev header set)
    time: new Date().toISOString(),
  });
}
