import { getDb, getEnv } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { sha256Hex } from "@/lib/crypto";
import { getSetupLinkByHash } from "@/lib/repo/setup-links";
import { getBorrower } from "@/lib/repo/borrowers";
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
  if (!borrower) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Setup unavailable</h1>
      </Shell>
    );
  }

  // Provisioning decides whether anything is left to approve. It returns null
  // once every account is authorised, which replaces the old single-consent
  // check: with more than one account, "the consent is authorised" was no longer
  // the same question as "the borrower has finished".
  const plaid = getPlaidClient(env);
  let step: Awaited<ReturnType<typeof provisionLinkToken>> = null;
  let error: string | null = null;
  let done = false;
  try {
    step = await provisionLinkToken(db, plaid, env.APP_ENCRYPTION_KEY, env, borrower.id);
    done = step === null;
  } catch (e) {
    console.error(`setup provisioning failed for borrower ${borrower.id}`, e);
    error = "Setup is temporarily unavailable. Please try again or contact Excel Capital.";
  }

  if (done) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">You&apos;re all set</h1>
        <p className="mt-2 text-sm text-slate-600">
          Your payment authorisation is already active. No further action needed.
        </p>
      </Shell>
    );
  }

  const multi = (step?.totalSteps ?? 1) > 1;

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Authorise repayments</h1>
      <p className="mt-2 text-sm text-slate-600">
        {borrower.legal_name}, set up a secure recurring payment authorisation
        with your bank through Plaid. Excel Capital never sees your bank login.
      </p>
      {multi && step && (
        // Told upfront, because being asked to approve a second account with no
        // warning looks like the first attempt failed. Approving both in one
        // sitting with the same bank login is the expected path.
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <p className="font-medium">
            Account {step.step} of {step.totalSteps}: {step.destinationLabel}
          </p>
          <p className="mt-1 text-slate-600">
            There {step.totalSteps === 2 ? "are two accounts" : `are ${step.totalSteps} accounts`} to
            approve. Use the same bank login each time. We&apos;ll bring you back here for the next
            one.
          </p>
        </div>
      )}
      {error ? (
        <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
      ) : (
        step && (
          <div className="mt-6">
            <SetupLauncher token={token} linkToken={step.linkToken} mode={plaid.mode} />
          </div>
        )
      )}
    </Shell>
  );
}
