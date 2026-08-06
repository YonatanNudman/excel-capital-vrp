import Link from "next/link";
import { getDb } from "@/lib/db";
import { listPayments, paymentSummary } from "@/lib/repo/payments";
import { listBorrowers } from "@/lib/repo/borrowers";
import { StatusBadge } from "@/components/status-badge";
import { formatMinor } from "@/lib/money";
import { paymentKind } from "@/lib/loan-progress";
import { PaymentKindTag } from "@/components/payment-kind-tag";
import type { PaymentStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: (PaymentStatus | "all")[] = [
  "all",
  "pending",
  "unknown",
  "submitted",
  "initiated",
  "executed",
  "settled",
  "failed",
  "rejected",
  "cancelled",
];

function ReconCard({
  label,
  count,
  amount,
  tone,
}: {
  label: string;
  count: number;
  amount: string;
  tone: "sky" | "emerald" | "red";
}) {
  const toneCls = {
    sky: "text-sky-700",
    emerald: "text-emerald-700",
    red: "text-red-700",
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneCls}`}>{amount}</div>
      <div className="text-xs text-slate-400">{count} payment{count === 1 ? "" : "s"}</div>
    </div>
  );
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    group?: string;
    borrower?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const status = (sp.status as PaymentStatus | "all") ?? "all";
  const group = sp.group === "problem" ? "problem" : null;
  const borrowerId = sp.borrower || null;
  const from = sp.from || null;
  const to = sp.to || null;
  const filtered = Boolean(group || borrowerId || from || to || status !== "all");
  const db = getDb();
  const [payments, borrowers, summary] = await Promise.all([
    listPayments(db, { status, group, borrowerId, from, to, limit: 300 }),
    listBorrowers(db, {}),
    paymentSummary(db),
  ]);
  const nameById = new Map(borrowers.map((b) => [b.id, b.legal_name]));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <a
          href="/api/payments/export"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Export CSV
        </a>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ReconCard
          label="In flight"
          count={summary.inFlightCount}
          amount={formatMinor(summary.inFlightMinor)}
          tone="sky"
        />
        <ReconCard
          label="Settled"
          count={summary.settledCount}
          amount={formatMinor(summary.settledMinor)}
          tone="emerald"
        />
        <ReconCard
          label="Failed / rejected"
          count={summary.failedCount}
          amount={formatMinor(summary.failedMinor)}
          tone="red"
        />
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Borrower</span>
          <select
            name="borrower"
            defaultValue={borrowerId ?? ""}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Everyone</option>
            {borrowers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.legal_name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Status</span>
          <select
            name="status"
            defaultValue={status}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm capitalize"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">From</span>
          <input
            type="date"
            name="from"
            defaultValue={from ?? ""}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">To</span>
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Apply
        </button>
        {/* The Monday-morning question, as one click. */}
        <Link
          href="/payments?group=problem"
          className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
            group === "problem"
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-slate-300 bg-white hover:bg-slate-50"
          }`}
        >
          Needs attention
        </Link>
        {filtered && (
          <Link
            href="/payments"
            className="rounded-md px-2 py-1.5 text-sm text-slate-500 hover:underline"
          >
            Clear
          </Link>
        )}
      </form>

      <p className="mb-3 text-sm text-slate-600">
        Showing {payments.length} payment{payments.length === 1 ? "" : "s"}
        {group === "problem" ? " that failed, were rejected, or are unconfirmed" : ""}
        {borrowerId ? ` for ${nameById.get(borrowerId) ?? "this borrower"}` : ""}
        {from || to ? ` between ${from ?? "the start"} and ${to ?? "today"}` : ""}
        {payments.length === 300 ? " (showing the most recent 300)" : ""}.
      </p>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Borrower</th>
              <th className="px-4 py-2.5 font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">What for</th>
              <th className="px-4 py-2.5 font-medium">Reference</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  {filtered
                    ? "No payments match those filters."
                    : "No payments yet."}
                </td>
              </tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 text-slate-600">{p.created_at.slice(0, 16).replace("T", " ")}</td>
                <td className="px-4 py-3">
                  <Link href={`/borrowers/${p.borrower_id}`} className="font-medium text-slate-900 hover:underline">
                    {nameById.get(p.borrower_id) ?? p.borrower_id.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-4 py-3 font-medium">{formatMinor(p.amount_minor, p.currency)}</td>
                <td className="px-4 py-3"><PaymentKindTag kind={paymentKind(p)} /></td>
                <td className="px-4 py-3 text-slate-600">{p.reference ?? "-"}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
