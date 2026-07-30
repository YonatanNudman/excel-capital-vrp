import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/repo/settings";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { updateSettingsAction } from "@/lib/actions/settings";
import { isPlaidConfigured } from "@/lib/plaid";
import { getEnv } from "@/lib/db";

export const dynamic = "force-dynamic";

/** One labelled input with a plain-English explanation underneath. */
function Field({
  name,
  label,
  help,
  defaultValue,
  type,
  wide,
  children,
}: {
  name: string;
  label: string;
  help: string;
  defaultValue?: string | number;
  type?: string;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <label className={`block ${wide ? "col-span-2" : ""}`}>
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      />
      <span className="mt-1 block text-xs text-slate-500">{help}</span>
      {children}
    </label>
  );
}

export default async function SettingsPage() {
  const db = getDb();
  const env = getEnv();
  const [s, user] = await Promise.all([getSettings(db), getCurrentUser()]);
  const isAdmin = user ? hasRole(user, "admin") : false;
  const plaidConnected = isPlaidConfigured(env);
  const realMoney = plaidConnected && env.PLAID_ENV === "production";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-6 text-sm text-slate-600">
        These control how the system collects repayments from borrowers.
      </p>

      <div className="mb-5 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">
          Is this the real thing?
        </h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <span className="text-slate-600">Is real money being moved?</span>
            <span
              className={`shrink-0 font-medium ${realMoney ? "text-red-700" : "text-emerald-700"}`}
            >
              {realMoney ? "Yes, this is real money" : "No, test money only"}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {realMoney
              ? "Payments made here move real money out of real bank accounts."
              : plaidConnected
                ? "This is a practice copy. It talks to the bank system in test mode, so nothing you do here touches anyone's real money."
                : "This is a practice copy and it is not connected to the bank system yet. Payments are only pretend."}
          </p>
          <div className="flex items-start justify-between gap-4 border-t border-slate-100 pt-3">
            <span className="text-slate-600">Which copy is this?</span>
            <span className="shrink-0 font-medium capitalize">{env.APP_ENV}</span>
          </div>
        </div>
      </div>

      {!isAdmin ? (
        <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
          You can see these settings, but only an admin can change them. Ask an
          admin if something here needs updating.
        </p>
      ) : (
        <form
          action={updateSettingsAction}
          className="space-y-5 rounded-lg border border-slate-200 bg-white p-5"
        >
          <div className="grid grid-cols-2 gap-5">
            <Field
              name="defaultRetryMax"
              type="number"
              defaultValue={s.default_retry_max}
              label="If a payment fails, how many times should we try again?"
              help="A payment can fail if the borrower has no money in their account. After this many tries, we give up and tell you."
            />
            <Field
              name="defaultRetrySpacingHours"
              type="number"
              defaultValue={s.default_retry_spacing_hours}
              label="How long should we wait before trying again?"
              help="In hours. Waiting gives the borrower time to put money in their account."
            />
            <Field
              name="defaultReferenceFormat"
              defaultValue={s.default_reference_format}
              wide
              label="What the borrower sees on their bank statement"
              help="Keep it short. Banks only show the first 18 letters, so anything longer gets cut off."
            >
              <span className="mt-1 block text-xs text-slate-500">
                Write {"{borrower}"} to fill in their name, {"{seq}"} for the
                payment number, or {"{date}"} for the date. Only letters and
                numbers come through: dashes, spaces and symbols are removed
                automatically, so EXCEL-{"{borrower}"} shows up as
                EXCELAcmeTrading.
              </span>
            </Field>
            <Field
              name="sendingDomain"
              defaultValue={s.sending_domain ?? ""}
              label="Which address do our emails come from?"
              help="Borrowers see this when we email them a setup link or a receipt."
            />
            <Field
              name="retentionDays"
              type="number"
              defaultValue={s.retention_days}
              label="How long should we keep old records?"
              help="In days. After this, old records are deleted. Ask your accountant before making this smaller."
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Save settings
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
