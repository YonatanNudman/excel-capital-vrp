import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getAuthenticatedEmail } from "@/lib/access";
import { getDb, getEnv } from "@/lib/db";
import { getRequestByEmail, pendingRequestCount } from "@/lib/repo/access-requests";
import { RequestAccess } from "@/components/request-access";
import { Nav } from "@/components/nav";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    // Authenticated by Cloudflare but not staff. Offer to ask for access rather
    // than showing a dead end. Not signed in at all still gets nothing.
    const env = getEnv();
    const email = await getAuthenticatedEmail(await headers(), env);
    if (!email) {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="text-xl font-semibold">Not signed in</h1>
          <p className="text-sm text-slate-600">Sign in again to continue.</p>
        </main>
      );
    }
    const existing = await getRequestByEmail(getDb(), email);
    return (
      <RequestAccess
        email={email}
        alreadyRequested={existing?.status === "pending"}
        denied={existing?.status === "denied"}
      />
    );
  }

  // Only admins can act on requests, so only they need the badge.
  const pendingRequests =
    user.role === "admin" ? await pendingRequestCount(getDb()) : 0;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-bold tracking-tight text-slate-900">
              Excel Capital
            </span>
            <Nav role={user.role} pendingRequests={pendingRequests} />
          </div>
          <div className="text-right text-xs text-slate-500">
            <div className="font-medium text-slate-700">{user.email}</div>
            <div className="capitalize">{user.role}</div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
