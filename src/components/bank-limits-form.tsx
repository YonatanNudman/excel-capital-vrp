"use client";

import { useActionState } from "react";
import {
  updateBankAndLimitsAction,
  type BankLimitsState,
} from "@/lib/actions/bank-limits";

const input =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm";

/**
 * Set the destination account and the payment limits. Shown on the borrower's
 * Edit page so an incomplete borrower can be completed, which previously was
 * impossible once created.
 */
export function BankLimitsForm({
  borrowerId,
  locked,
  defaults,
}: {
  borrowerId: string;
  locked: boolean;
  defaults: {
    recipientName: string;
    accountNumber: string;
    sortCode: string;
    maxPaymentAmount: string;
    periodicMaxAmount: string;
    consentPeriod: string;
  };
}) {
  const [state, formAction, pending] = useActionState<BankLimitsState, FormData>(
    updateBankAndLimitsAction,
    null,
  );
  // Prefer what was just typed over what is stored, so a validation error never
  // discards the operator's work.
  const shown = { ...defaults, ...(state?.values ?? {}) };

  if (locked) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
        <p className="font-medium text-slate-800">
          These are locked in with the borrower&apos;s bank.
        </p>
        <p className="mt-1">
          The borrower has already agreed these limits, so changing them here
          would no longer match what their bank approved. To use different
          limits, send a new setup link and ask them to approve again.
        </p>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <input type="hidden" name="borrowerId" value={borrowerId} />

      <div>
        <h2 className="text-sm font-semibold text-slate-900">
          Where repayments are sent
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Your own bank account. This is where the borrower&apos;s money lands.
        </p>
      </div>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Account name</span>
        <input name="recipientName" defaultValue={shown.recipientName} className={input} />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Account number</span>
          <input
            name="recipientAccount"
            placeholder="12345678"
            defaultValue={shown.accountNumber}
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">8 digits.</span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Sort code</span>
          <input
            name="recipientSort"
            placeholder="12-34-56"
            defaultValue={shown.sortCode}
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">6 digits. Dashes are fine.</span>
        </label>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <h2 className="text-sm font-semibold text-slate-900">Payment limits</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          The borrower approves these with their bank. You can never take more
          than this, which is what makes it safe for them to agree.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            Most in one payment
          </span>
          <input
            name="maxPaymentAmount"
            type="number"
            step="0.01"
            placeholder="500.00"
            defaultValue={shown.maxPaymentAmount}
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">In pounds.</span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Most per period</span>
          <input
            name="periodicMaxAmount"
            type="number"
            step="0.01"
            placeholder="2000.00"
            defaultValue={shown.periodicMaxAmount}
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Must be at least the single payment limit.
          </span>
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">The period is</span>
        <select
          name="consentPeriod"
          defaultValue={shown.consentPeriod || "MONTH"}
          className={input}
        >
          <option value="DAY">Per day</option>
          <option value="WEEK">Per week</option>
          <option value="MONTH">Per month</option>
          <option value="YEAR">Per year</option>
        </select>
      </label>

      {state?.errors && state.errors.length > 0 && (
        <ul
          role="alert"
          className="list-disc space-y-1 rounded-md border border-red-200 bg-red-50 p-3 pl-7 text-sm text-red-800"
        >
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {state?.saved && (
        <p
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          ✓ Saved. This borrower is ready for a setup link now.
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save bank details and limits"}
        </button>
      </div>
    </form>
  );
}
