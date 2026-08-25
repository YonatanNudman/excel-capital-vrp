import Link from "next/link";
import { getDb } from "@/lib/db";
import { listBorrowers } from "@/lib/repo/borrowers";
import { StatusBadge } from "@/components/status-badge";
import type { BorrowerStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: (BorrowerStatus | "all")[] = [
  "all",
  "onboarding",
  "active",
  "paused",
  "revoked",
  "expired",
];

export default async function BorrowersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const search = sp.q ?? "";
  const status = (sp.status as BorrowerStatus | "all") ?? "all";
  const borrowers = await listBorrowers(getDb(), { search, status });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Borrowers</h1>
        <Link href="/borrowers/archived" className="text-sm text-slate-500 hover:underline">
          View archived
        </Link>
        <Link
          href="/borrowers/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          New borrower
        </Link>
      </div>

      <form className="mb-4 flex flex-wrap items-center gap-2" method="get">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search name or company number"
          className="w-72 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
        />
        <select
          name="status"
          defaultValue={status}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm capitalize"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Filter
        </button>
      </form>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Legal name</th>
              <th className="px-4 py-2.5 font-medium">Company no.</th>
              <th className="px-4 py-2.5 font-medium">Contact</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {borrowers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No borrowers found.
                </td>
              </tr>
            )}
            {borrowers.map((b) => (
              <tr key={b.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link href={`/borrowers/${b.id}`} className="font-medium text-slate-900 hover:underline">
                    {b.legal_name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-600">{b.company_number ?? "-"}</td>
                <td className="px-4 py-3 text-slate-600">{b.contact_email ?? "-"}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={b.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
