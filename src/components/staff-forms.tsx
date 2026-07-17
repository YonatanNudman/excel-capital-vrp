"use client";

import { useActionState } from "react";
import {
  addStaffAction,
  setStaffDisabledAction,
  setStaffRoleAction,
  type StaffActionState,
} from "@/lib/actions/staff";
import type { Role } from "@/lib/types";

const ROLES: Role[] = ["admin", "operator", "viewer"];

export function AddStaffForm() {
  const [state, formAction, pending] = useActionState<StaffActionState, FormData>(
    addStaffAction,
    null,
  );
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Email</span>
        <input
          name="email"
          type="email"
          required
          placeholder="person@example.com"
          className="mt-1 w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Role</span>
        <select
          name="role"
          defaultValue="viewer"
          className="mt-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm capitalize"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add staff"}
      </button>
      {state?.message && (
        <p className="w-full text-xs text-slate-600">{state.message}</p>
      )}
    </form>
  );
}

export function StaffRoleForm({ staffId, role }: { staffId: string; role: Role }) {
  const [state, formAction, pending] = useActionState<StaffActionState, FormData>(
    setStaffRoleAction,
    null,
  );
  return (
    <div className="flex items-center gap-2">
      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="staffId" value={staffId} />
        <select
          name="role"
          defaultValue={role}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm capitalize"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {pending ? "…" : "Save"}
        </button>
      </form>
      {state?.message && (
        <span className="text-xs text-slate-500">{state.message}</span>
      )}
    </div>
  );
}

export function StaffDisableForm({
  staffId,
  disabled,
}: {
  staffId: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState<StaffActionState, FormData>(
    setStaffDisabledAction,
    null,
  );
  return (
    <span className="inline-flex items-center gap-2">
      <form action={formAction}>
        <input type="hidden" name="staffId" value={staffId} />
        <input type="hidden" name="disable" value={disabled ? "false" : "true"} />
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {pending ? "…" : disabled ? "Enable" : "Disable"}
        </button>
      </form>
      {state?.message && (
        <span className="text-xs text-slate-500">{state.message}</span>
      )}
    </span>
  );
}
