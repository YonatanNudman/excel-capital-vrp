import Link from "next/link";
import { getDb } from "@/lib/db";
import { listArchivedBorrowers } from "@/lib/repo/borrowers";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { RestoreBorrowerButton } from "@/components/archive-buttons";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

/**
 * Archived borrowers, and the way back.
 *
 * This page is why archiving is safe to offer at all. Without it an archived
 * borrower is invisible with no route back except editing the database, and a
 * mis-click would lose them for good.
 */
export default async function ArchivedBorrowersPage() {
  const db = getDb();
  const [borrowers, user] = await Promise.all([listArchivedBorrowers(db), getCurrentUser()]);
  const canOperate = user ? hasRole(user, "operator") : false;

  return (
    <div>
      <div className="mb-6">
        <Link href="/borrowers" className="text-sm text-slate-500 hover:underline">
          ← Borrowers
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Archived borrowers</h1>
        <p className="mt-1 text-sm text-slate-600">
          Hidden from the main list. Nothing has been deleted: their payments and
          history are kept, and restoring puts them back.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-3 font-medium">Business</th>
              <th className="px-5 py-3 font-medium">Company number</th>
              <th className="px-5 py-3 font-medium">Status when archived</th>
              <th className="px-5 py-3 font-medium">Archived</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {borrowers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                  Nothing archived.
                </td>
              </tr>
            )}
            {borrowers.map((b) => (
              <tr key={b.id}>
                <td className="px-5 py-3 font-medium text-slate-800">{b.legal_name}</td>
                <td className="px-5 py-3 text-slate-600">{b.company_number ?? "-"}</td>
                <td className="px-5 py-3"><StatusBadge status={b.status} /></td>
                <td className="px-5 py-3 text-slate-600">{b.deleted_at?.slice(0, 10)}</td>
                <td className="px-5 py-3 text-right">
                  {canOperate && <RestoreBorrowerButton borrowerId={b.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
