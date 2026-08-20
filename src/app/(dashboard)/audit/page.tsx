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
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <a
          href="/api/audit/export"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
        Export CSV
        </a>
      </div>

      <div className="max-h-cvh overflow-x-auto overflow-y-hidden rounded-lg border border-slate-200 bg-white flex flex-col">
        <table className="w-full table-fixed text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Actor</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Entity</th>
              <th className="px-4 py-2.5 font-medium">Details</th>
            </tr>
          </thead>
        </table>
        <div className="flex-1 overflow-y-auto">
          <table className="w-full table-fixed">
            <tbody className="divide-y divide-slate-100">
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                    No audit entries yet.
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-600">{e.created_at.slice(0, 19).replace("T", " ")}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {e.actor_staff_id ? emailById.get(e.actor_staff_id) ?? "-" : "system"}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{e.action}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {e.entity_type ? `${e.entity_type}:${e.entity_id?.slice(0, 10)}` : "-"}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{e.metadata ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
