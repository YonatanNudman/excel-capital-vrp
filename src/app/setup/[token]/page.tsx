import { getDb, getEnv } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { sha256Hex } from "@/lib/crypto";
import { getSetupLinkByHash } from "@/lib/repo/setup-links";
import { getBorrower } from "@/lib/repo/borrowers";
import { getActiveConsent } from "@/lib/repo/consents";
import { provisionLinkToken } from "@/lib/engine/setup";
import { SetupLauncher } from "@/components/setup-launcher";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-sm font-bold tracking-tight text-slate-900">Excel Capital</div>
        {children}
      </div>
    </main>
  );
}

export default async function SetupPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = getDb();
  const env = getEnv();

  const link = await getSetupLinkByHash(db, await sha256Hex(token));
  if (!link || new Date(link.expires_at) < new Date()) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Link invalid or expired</h1>
        <p className="mt-2 text-sm text-slate-600">
          Please ask Excel Capital to send you a new setup link.
        </p>
      </Shell>
    );
  }

  const borrower = await getBorrower(db, link.borrower_id);
  const consent = await getActiveConsent(db, link.borrower_id);
  if (!borrower) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Setup unavailable</h1>
      </Shell>
    );
  }

  if (consent?.status === "authorized") {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">You&apos;re all set</h1>
        <p className="mt-2 text-sm text-slate-600">
          Your payment authorisation is already active. No further action needed.
        </p>
      </Shell>
    );
  }

  const plaid = getPlaidClient(env);
  let linkToken: string | null = null;
  let error: string | null = null;
  try {
    const prov = await provisionLinkToken(db, plaid, env.APP_ENCRYPTION_KEY, env, borrower.id);
    linkToken = prov.linkToken;
  } catch (e) {
    console.error(`setup provisioning failed for borrower ${borrower.id}`, e);
    error = "Setup is temporarily unavailable. Please try again or contact Excel Capital.";
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Authorise repayments</h1>
      <p className="mt-2 text-sm text-slate-600">
        {borrower.legal_name}, set up a secure recurring payment authorisation
        with your bank through Plaid. Excel Capital never sees your bank login.
      </p>
      {error ? (
        <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
      ) : (
        <div className="mt-6">
          <SetupLauncher
            token={token}
            linkToken={linkToken!}
            mode={plaid.mode}
          />
        </div>
      )}
    </Shell>
  );
}
