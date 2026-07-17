import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getBorrower } from "@/lib/repo/borrowers";
import { getActiveSchedule } from "@/lib/repo/schedules";
import { updateScheduleAction } from "@/lib/actions/borrowers";
import { fromMinorUnits } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const borrower = await getBorrower(db, id);
  if (!borrower) notFound();
  const s = await getActiveSchedule(db, id);

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
            <select name="frequency" defaultValue={s?.frequency ?? "monthly"} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom (every N days)</option>
            </select>
          </label>
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
        <div className="flex justify-end">
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
            Save schedule
          </button>
        </div>
      </form>
    </div>
  );
}
