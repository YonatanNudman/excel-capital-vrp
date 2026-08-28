import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { getBorrower } from "@/lib/repo/borrowers";
import { getActiveSchedule, isStoredDaily, parseDaysOfWeek } from "@/lib/repo/schedules";
import { updateScheduleAction } from "@/lib/actions/borrowers";
import { fromMinorUnits } from "@/lib/money";

import { WeekdayPicker } from "@/components/weekday-picker";
import { listDestinations } from "@/lib/repo/destinations";
import { destinationLabel } from "@/lib/destinations";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Operators only, matching the action behind this form. A viewer reaching it
  // by URL got a form that could only fail on submit.
  const user = await getCurrentUser();
  if (!user || !hasRole(user, "operator")) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href={`/borrowers/${id}`} className="text-sm text-slate-500 hover:underline">
          ← Back to borrower
        </Link>
        <p className="mt-4 rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
          You have view-only access, so you cannot change a repayment schedule.
        </p>
      </div>
    );
  }

  const db = getDb();
  const borrower = await getBorrower(db, id);
  if (!borrower) notFound();
  const s = await getActiveSchedule(db, id);
  const destinations = await listDestinations(db, id);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/borrowers/${id}`} className="text-sm text-slate-500 hover:underline">
        ← {borrower.legal_name}
      </Link>
      <h1 className="mt-1 mb-6 text-2xl font-semibold tracking-tight">Repayment schedule</h1>

      <form action={updateScheduleAction} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <input type="hidden" name="borrowerId" value={id} />
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Amount (£) *</span>
            <input
              name="amount"
              type="number"
              step="0.01"
              required
              defaultValue={s ? fromMinorUnits(s.amount_minor) : ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Frequency *</span>
            {/* A daily schedule is stored as custom/1-day (migration 0004), so the
                raw column says "custom". Defaulting the picker to that meant
                re-saving a Mon-Fri schedule submitted frequency=custom, the
                weekday list was discarded, and the borrower started being
                collected from at weekends. */}
            <select
              name="frequency"
              defaultValue={s ? (isStoredDaily(s) ? "daily" : s.frequency) : "monthly"}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            >
              <option value="daily">Daily (choose which days below)</option>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom (every N days)</option>
            </select>
          </label>
          <WeekdayPicker selected={parseDaysOfWeek(s?.days_of_week)} />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Interval days (custom)</span>
            <input name="intervalDays" type="number" defaultValue={s?.interval_days ?? ""} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Start date *</span>
            <input name="startDate" type="date" required defaultValue={s?.start_date ?? ""} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">End mode *</span>
            <select name="endMode" defaultValue={s?.end_mode ?? "count"} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
              <option value="count">After N payments</option>
              <option value="date">On a fixed date</option>
              <option value="total">When a total is collected</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">End: number of payments</span>
            <input name="endCount" type="number" defaultValue={s?.end_count ?? ""} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">End: date</span>
            <input name="endDate" type="date" defaultValue={s?.end_date ?? ""} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">End: total (£)</span>
            <input name="endTotal" type="number" step="0.01" defaultValue={s?.end_total_minor ? fromMinorUnits(s.end_total_minor) : ""} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
        </div>
        {destinations.length <= 1 && s?.consent_id && (
          // With one account the picker is not shown, but the form must still
          // carry the schedule's existing mandate: an absent field posts as
          // "default account" and quietly unpins it.
          <input type="hidden" name="destinationConsentId" value={s.consent_id} />
        )}
        {destinations.length > 1 && (
          // Only offered when there is a real choice. Unlike the one-off picker
          // this lists accounts the borrower has not approved yet, because
          // configuring the schedule before sending the setup link is the normal
          // order of work.
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Pay repayments into</span>
            <select
              name="destinationConsentId"
              defaultValue={s?.consent_id ?? ""}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            >
              <option value="">Default account</option>
              {destinations
                .filter(
                  (d) =>
                    d.consent &&
                    // The account this schedule ALREADY pays into always appears,
                    // even if it has since been retired. A <select> whose stored
                    // value is not among its options silently selects the first
                    // one, so simply saving the page moved the borrower's
                    // collections to the default account with nothing said.
                    (!d.recipient?.archived_at || d.consent.id === s?.consent_id),
                )
                .map((d) => (
                  <option key={d.consent!.id} value={d.consent!.id}>
                    {destinationLabel(d)}
                    {d.recipient?.is_default ? " (default)" : ""}
                    {d.recipient?.archived_at ? " — retired" : ""}
                    {d.consent!.status !== "authorized" ? " — not approved yet" : ""}
                  </option>
                ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              Every scheduled collection goes here. One-off payments can go elsewhere.
            </span>
          </label>
        )}
        <div className="flex justify-end">
          <SubmitButton
            pendingLabel="Saving…"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Save schedule
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
