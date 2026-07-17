import { getDb } from "@/lib/db";
import { listAudit } from "@/lib/repo/audit";
import { listStaff } from "@/lib/repo/staff";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const db = getDb();
  const [entries, staff] = await Promise.all([listAudit(db, { limit: 300 }), listStaff(db)]);
  const emailById = new Map(staff.map((s) => [s.id, s.email]));

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Audit log</h1>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Actor</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Entity</th>
              <th className="px-4 py-2.5 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No audit entries yet.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2.5 text-slate-600">{e.created_at.slice(0, 19).replace("T", " ")}</td>
                <td className="px-4 py-2.5 text-slate-600">
                  {e.actor_staff_id ? emailById.get(e.actor_staff_id) ?? "—" : "system"}
                </td>
                <td className="px-4 py-2.5 font-medium text-slate-800">{e.action}</td>
                <td className="px-4 py-2.5 text-slate-600">
                  {e.entity_type ? `${e.entity_type}:${e.entity_id?.slice(0, 8)}` : "—"}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{e.metadata ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
