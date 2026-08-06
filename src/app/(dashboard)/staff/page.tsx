import { getDb } from "@/lib/db";
import { listStaff } from "@/lib/repo/staff";
import { listPendingRequests } from "@/lib/repo/access-requests";
import { AccessRequestQueue } from "@/components/access-request-queue";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { StatusBadge } from "@/components/status-badge";
import {
  AddStaffForm,
  StaffDisableForm,
  StaffRoleForm,
} from "@/components/staff-forms";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const user = await getCurrentUser();

  if (!user || !hasRole(user, "admin")) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Staff</h1>
        <p className="text-sm text-slate-500">Admins only.</p>
      </div>
    );
  }

  const [staff, pendingRequests] = await Promise.all([
    listStaff(getDb()),
    listPendingRequests(getDb()),
  ]);

  return (
    <div>
      {pendingRequests.length > 0 && (
        <AccessRequestQueue requests={pendingRequests} />
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage who can access the platform and what they can do.
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add staff
        </h2>
        <AddStaffForm />
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Last login</th>
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {staff.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No staff yet.
                </td>
              </tr>
            )}
            {staff.map((s) => {
              const isDisabled = s.disabled_at != null;
              return (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-900">{s.email}</span>
                    {s.id === user.id && (
                      <span className="ml-2 text-xs text-slate-400">(you)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StaffRoleForm staffId={s.id} role={s.role} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={isDisabled ? "disabled" : "active"} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {s.last_login_at ? s.last_login_at.slice(0, 10) : "never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <StaffDisableForm staffId={s.id} disabled={isDisabled} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
