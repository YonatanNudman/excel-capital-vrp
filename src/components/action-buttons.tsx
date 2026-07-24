"use client";

import { useActionState, useState } from "react";
import {
  sendSetupLinkAction,
  type SetupLinkState,
} from "@/lib/actions/setup";
import {
  executePaymentNowAction,
  retryPaymentAction,
  type ActionState,
} from "@/lib/actions/payments";

const btn =
  "rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 transition-colors";

export function SetupLinkButton({ borrowerId }: { borrowerId: string }) {
  const [state, formAction, pending] = useActionState<SetupLinkState, FormData>(
    sendSetupLinkAction,
    null,
  );
  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="borrowerId" value={borrowerId} />
        <button
          type="submit"
          disabled={pending}
          className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
        >
          {pending ? "Generating…" : "Generate setup link"}
        </button>
      </form>
      {state?.url && (
        <div className="mt-2 rounded-md bg-slate-50 p-2 text-xs">
          <div className="mb-1 text-slate-500">Share this single-use link (expires in 72h):</div>
          <code className="break-all text-slate-800">{state.url}</code>
          {state.emailed && (
            <div className="mt-1 text-slate-500">Emailed to borrower</div>
          )}
        </div>
      )}
      {state?.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </div>
  );
}

export function ExecuteNowButton({
  borrowerId,
  nonce,
  amountLabel,
}: {
  borrowerId: string;
  nonce: string;
  amountLabel: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    executePaymentNowAction,
    null,
  );
  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="borrowerId" value={borrowerId} />
        <input type="hidden" name="nonce" value={nonce} />
        {confirming ? (
          <>
            <span className="text-sm font-medium text-amber-800">Collect {amountLabel} now?</span>
            <button
              type="submit"
              disabled={pending}
              className={`${btn} bg-red-700 text-white hover:bg-red-600`}
            >
              {pending ? "Submitting…" : "Confirm collection"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`${btn} bg-slate-900 text-white hover:bg-slate-700`}
          >
            Execute payment now
          </button>
        )}
      </form>
      {state?.message && <p className="mt-1 text-xs text-slate-600">{state.message}</p>}
    </div>
  );
}

export function RetryButton({ paymentId }: { paymentId: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    retryPaymentAction,
    null,
  );
  return (
    <span className="inline-flex items-center gap-2">
      <form action={formAction}>
        <input type="hidden" name="paymentId" value={paymentId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {pending ? "…" : "Retry"}
        </button>
      </form>
      {state?.message && <span className="text-xs text-slate-500">{state.message}</span>}
    </span>
  );
}
