"use client";

import { useActionState } from "react";
import {
  decideRequestAction,
  type DecideState,
} from "@/lib/actions/access-requests";
import type { AccessRequest } from "@/lib/repo/access-requests";

/**
 * Pending access requests, with the decision made in one click.
 *
 * Approving requires picking a role explicitly: the server refuses to approve
 * without one rather than defaulting someone's permissions.
 */
export function AccessRequestQueue({ requests }: { requests: AccessRequest[] }) {
  const [state, formAction, pending] = useActionState<DecideState, FormData>(
    decideRequestAction,
    null,
  );

  return (
    <section className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-5">
      <h2 className="text-sm font-semibold text-amber-900">
        {requests.length === 1
          ? "1 person is waiting for access"
          : `${requests.length} people are waiting for access`}
      </h2>
      <p className="mt-1 text-xs text-amber-900">
        They cannot see anything until you approve them. Denying someone stops
        them asking again.
      </p>

      {state?.message && (
        <p
          role="status"
          className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900"
        >
          {state.message}
        </p>
      )}
      {state?.error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800"
        >
          {state.error}
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {requests.map((r) => (
          <li key={r.id} className="rounded-md border border-amber-200 bg-white p-3">
            <div className="text-sm font-medium text-slate-900">{r.email}</div>
            <div className="text-xs text-slate-500">
              Asked {r.requested_at.slice(0, 10)}
            </div>
            {r.note && (
              <p className="mt-1 text-sm text-slate-700">&ldquo;{r.note}&rdquo;</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <form action={formAction} className="flex items-center gap-2">
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="decision" value="approve" />
                <select
                  name="role"
                  defaultValue="viewer"
                  aria-label={`Role for ${r.email}`}
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  <option value="viewer">Can look only</option>
                  <option value="operator">Can take payments</option>
                  <option value="admin">Full admin</option>
                </select>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  Approve
                </button>
              </form>
              <form action={formAction}>
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="decision" value="deny" />
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                >
                  Deny
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
