import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireRole, AuthError } from "@/lib/auth";
import {
  getCompaniesHouseClient,
  CompaniesHouseError,
  companiesHouseFailureMessage,
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
    // Log the status so production tells us WHICH failure this was. The message
    // shown to staff already distinguishes them, but the log is what turns a
    // report of "it does not work" into an answer without a live debugging session.
    const status = error instanceof CompaniesHouseError ? error.httpStatus : undefined;
    console.error("companies house search failed", { httpStatus: status, error: String(error) });
    return Response.json(
      { configured: true, results: [], error: companiesHouseFailureMessage(error) },
      { status: 502 },
    );
  }
}
