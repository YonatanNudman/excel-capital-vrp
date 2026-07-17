import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/repo/settings";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { updateSettingsAction } from "@/lib/actions/settings";
import { isPlaidConfigured } from "@/lib/plaid";
import { getEnv } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const db = getDb();
  const env = getEnv();
  const [s, user] = await Promise.all([getSettings(db), getCurrentUser()]);
  const isAdmin = user ? hasRole(user, "admin") : false;
  const plaidLive = isPlaidConfigured(env);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Settings</h1>

      <div className="mb-5 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Environment
        </h2>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">App environment</span>
            <span className="font-medium capitalize">{env.APP_ENV}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Plaid mode</span>
            <span className={`font-medium ${plaidLive ? "text-emerald-700" : "text-amber-700"}`}>
              {plaidLive ? `real (${env.PLAID_ENV})` : "mock (no credentials yet)"}
            </span>
          </div>
        </div>
      </div>

      {!isAdmin ? (
        <p className="text-sm text-slate-500">Only admins can edit settings.</p>
      ) : (
        <form action={updateSettingsAction} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Default retry max</span>
              <input name="defaultRetryMax" type="number" defaultValue={s.default_retry_max} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Retry spacing (hours)</span>
              <input name="defaultRetrySpacingHours" type="number" defaultValue={s.default_retry_spacing_hours} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
            </label>
            <label className="block col-span-2">
              <span className="text-sm font-medium text-slate-700">Reference format</span>
              <input name="defaultReferenceFormat" defaultValue={s.default_reference_format} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
              <span className="mt-0.5 block text-xs text-slate-400">Tokens: {"{borrower}"} {"{seq}"} {"{date}"} — trimmed to 18 chars.</span>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Sending domain</span>
              <input name="sendingDomain" defaultValue={s.sending_domain ?? ""} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Retention (days)</span>
              <input name="retentionDays" type="number" defaultValue={s.retention_days} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
            </label>
          </div>
          <div className="flex justify-end">
            <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
              Save settings
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
