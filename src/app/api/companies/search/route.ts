import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireRole, AuthError } from "@/lib/auth";
import {
  getCompaniesHouseClient,
  CompaniesHouseError,
} from "@/lib/companies-house";

export const dynamic = "force-dynamic";

/**
 * Company search for the onboarding form.
 *
 * Proxied through the Worker so the Companies House API key stays a server
 * secret. Staff-only: this is a lookup tool for operators, not a public search.
 */
export async function GET(request: Request) {
  try {
    await requireRole("operator");
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ error: "Not authorised." }, { status: 403 });
    }
    throw error;
  }

  const { env } = getCloudflareContext();
  const client = getCompaniesHouseClient(env);
  if (!client) {
    return Response.json(
      { configured: false, results: [] },
      { status: 200 },
    );
  }

  const query = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const results = await client.search(query);
    return Response.json({ configured: true, results });
  } catch (error) {
    const message =
      error instanceof CompaniesHouseError
        ? "Could not reach Companies House. Try again, or type the details in by hand."
        : "Something went wrong searching Companies House.";
    console.error("companies house search failed", error);
    return Response.json({ configured: true, results: [], error: message }, { status: 502 });
  }
}
