"use client";

import { useActionState, useState } from "react";
import {
  addDestinationAction,
  archiveDestinationAction,
  setDefaultDestinationAction,
  type DestinationState,
} from "@/lib/actions/destinations";

/** One account as the panel needs it, already masked and decided server-side. */
export interface DestinationRow {
  recipientId: string | null;
  consentId: string | null;
  label: string;
  masked: string;
  isDefault: boolean;
  isArchived: boolean;
  /** Null when ready to collect; otherwise why not, in operator language. */
  blockedReason: string | null;
}

const btn = "rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50";

function Messages({ state }: { state: DestinationState }) {
  if (!state) return null;
  if (state.errors?.length) {
    return (
      <ul role="alert" className="mt-2 space-y-1 rounded-md bg-red-50 p-3 text-sm text-red-800">
        {state.errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    );
  }
  if (state.saved) {
    return (
      <p role="status" className="mt-2 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
        {state.saved}
      </p>
    );
  }
  return null;
}

function RowActions({ borrowerId, row }: { borrowerId: string; row: DestinationRow }) {
  const [defState, setDefault, settingDefault] = useActionState<DestinationState, FormData>(
    setDefaultDestinationAction,
    null,
  );
  const [archState, archive, archiving] = useActionState<DestinationState, FormData>(
    archiveDestinationAction,
    null,
  );
  const [confirmArchive, setConfirmArchive] = useState(false);

  // A legacy mandate with no account row of its own cannot be managed here.
  if (!row.recipientId) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!row.isDefault && !row.isArchived && (
        <form action={setDefault}>
          <input type="hidden" name="borrowerId" value={borrowerId} />
          <input type="hidden" name="recipientId" value={row.recipientId} />
          <button
            type="submit"
            disabled={settingDefault}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {settingDefault ? "…" : "Make default"}
          </button>
        </form>
      )}
      {!row.isDefault && !row.isArchived && (
        <form action={archive}>
          <input type="hidden" name="borrowerId" value={borrowerId} />
          <input type="hidden" name="recipientId" value={row.recipientId} />
          {confirmArchive ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="submit"
                disabled={archiving}
                className="rounded bg-red-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {archiving ? "…" : "Confirm retire"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmArchive(false)}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmArchive(true)}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Retire
            </button>
          )}
        </form>
      )}
      <Messages state={defState} />
      <Messages state={archState} />
    </div>
  );
}

function AddForm({ borrowerId }: { borrowerId: string }) {
  const [state, formAction, pending] = useActionState<DestinationState, FormData>(
    addDestinationAction,
    null,
  );
  const [open, setOpen] = useState(false);

  // Close on success so the newly added account is visible in the list above.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.saved) setOpen(false);
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
        >
          Add another bank account
        </button>
        <Messages state={state} />
      </div>
    );
  }

  const field = "mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm";
  const labelCls = "text-xs font-medium text-slate-700";

  return (
    <form action={formAction} className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <input type="hidden" name="borrowerId" value={borrowerId} />
      <p className="mb-3 text-sm text-slate-700">
        The borrower has to approve each account separately with their bank. After adding this,
        send them a new setup link. They can approve every account in one sitting using the same
        bank login.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>What to call it</span>
          <input name="label" placeholder="Backup account" className={field} />
          <span className="mt-1 block text-xs text-slate-500">
            Only you see this. It is how you will pick it when collecting.
          </span>
        </label>
        <label className="block">
          <span className={labelCls}>Name on the account</span>
          <input name="recipientName" required placeholder="Excel Capital Ltd" className={field} />
        </label>
        <label className="block">
          <span className={labelCls}>Account number</span>
          <input name="recipientAccount" required placeholder="12345678" className={field} />
        </label>
        <label className="block">
          <span className={labelCls}>Sort code</span>
          <input name="recipientSort" required placeholder="12-34-56" className={field} />
        </label>
        <label className="block">
          <span className={labelCls}>Most in one payment (£)</span>
          <input name="maxPaymentAmount" required type="number" step="0.01" min="0.01" className={field} />
        </label>
        <label className="block">
          <span className={labelCls}>Most in a period (£)</span>
          <input name="periodicMaxAmount" required type="number" step="0.01" min="0.01" className={field} />
        </label>
        <label className="block">
          <span className={labelCls}>Period the limit covers</span>
          <select name="consentPeriod" defaultValue="MONTH" className={field}>
            <option value="DAY">Day</option>
            <option value="WEEK">Week</option>
            <option value="MONTH">Month</option>
            <option value="YEAR">Year</option>
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Mandate ends (optional)</span>
          <input name="consentValidTo" type="datetime-local" className={field} />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button type="submit" disabled={pending} className={`${btn} bg-slate-900 text-white hover:bg-slate-700`}>
          {pending ? "Adding…" : "Add account"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
        >
          Cancel
        </button>
      </div>
      <Messages state={state} />
    </form>
  );
}

/**
 * Manage where this borrower's repayments are sent.
 *
 * Each account carries its own mandate, because Plaid binds a mandate
 * permanently to one account. That is what makes picking a destination safe: the
 * money is never rerouted after the borrower approved it, so the account shown
 * here is genuinely where it lands.
 */
export function DestinationsPanel({
  borrowerId,
  rows,
  combined,
}: {
  borrowerId: string;
  rows: DestinationRow[];
  /** Pre-formatted combined ceiling warning, or null when there is one mandate. */
  combined: string | null;
}) {
  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {rows.length === 0 && (
          <li className="py-3 text-sm text-slate-400">No bank account added yet.</li>
        )}
        {rows.map((row) => (
          <li
            key={row.recipientId ?? row.consentId}
            className="flex flex-wrap items-start justify-between gap-3 py-3"
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                {row.label}
                {row.isDefault && (
                  <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Default
                  </span>
                )}
                {row.isArchived && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    Retired
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500">{row.masked}</div>
              <div
                className={`text-xs ${row.blockedReason ? "text-amber-700" : "text-emerald-700"}`}
              >
                {row.blockedReason ?? "Ready to receive money"}
              </div>
            </div>
            <RowActions borrowerId={borrowerId} row={row} />
          </li>
        ))}
      </ul>

      {combined && (
        // The genuine risk of multiple mandates: each one looks reasonable on its
        // own while the total the banks will permit is larger than anyone reading
        // a single mandate would assume. Stated plainly rather than buried.
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {combined}
        </p>
      )}

      <div className="mt-4">
        <AddForm borrowerId={borrowerId} />
      </div>
    </div>
  );
}
