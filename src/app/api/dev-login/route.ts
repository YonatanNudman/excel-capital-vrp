import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

/**
 * Local-development login helper. Sets the dev identity cookie that
 * getAuthenticatedEmail honours ONLY when APP_ENV=development, so the dashboard
 * can be used in a normal browser without Cloudflare Access in front.
 * Returns 404 in every deployed environment.
 */
export async function GET(request: Request) {
  const { env } = getCloudflareContext();
  if (env.APP_ENV !== "development") {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return new Response("Pass ?email=you@example.com", { status: 400 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/borrowers",
      "Set-Cookie": `dev_user_email=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax`,
    },
  });
}
