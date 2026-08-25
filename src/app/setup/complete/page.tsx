import { SetupResume } from "@/components/setup-resume";

export const dynamic = "force-dynamic";

/**
 * Where the borrower's bank returns them after authorising.
 *
 * This is the redirect_uri registered with Plaid
 * ({APP_BASE_URL}/setup/complete). It must be a STATIC segment so it wins over
 * the sibling /setup/[token] route: before this existed, a returning borrower
 * matched [token] with "complete" as their token and was told their link was
 * invalid, moments after their bank had approved it.
 */
export default function SetupCompletePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-sm font-bold tracking-tight text-slate-900">Excel Capital</div>
        <h1 className="text-lg font-semibold">Finishing up</h1>
        <p className="mt-2 mb-4 text-sm text-slate-600">
          Thanks. We are confirming the authorisation with your bank. This only
          takes a moment.
        </p>
        <SetupResume />
      </div>
    </main>
  );
}
