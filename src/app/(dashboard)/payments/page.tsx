import Link from "next/link";
import { getDb } from "@/lib/db";
import { listPayments } from "@/lib/repo/payments";
import { listBorrowers } from "@/lib/repo/borrowers";
import { StatusBadge } from "@/components/status-badge";
import { formatMinor } from "@/lib/money";
import type { PaymentStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: (PaymentStatus | "all")[] = [
  "all",
  "pending",
  "submitted",
  "initiated",
  "executed",
  "settled",
  "failed",
  "rejected",
  "cancelled",
];

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const status = (sp.status as PaymentStatus | "all") ?? "all";
  const db = getDb();
  const [payments, borrowers] = await Promise.all([
    listPayments(db, { status, limit: 300 }),
    listBorrowers(db, {}),
  ]);
  const nameById = new Map(borrowers.map((b) => [b.id, b.legal_name]));

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Payments</h1>

      <form method="get" className="mb-4 flex items-center gap-2">
        <select name="status" defaultValue={status} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm capitalize">
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
          Filter
        </button>
      </form>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Borrower</th>
              <th className="px-4 py-2.5 font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">Reference</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {payments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No payments.
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
                <td className="px-4 py-3 text-slate-600">{p.reference ?? "—"}</td>
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
