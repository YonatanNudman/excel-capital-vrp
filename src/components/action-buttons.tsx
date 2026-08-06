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
  type ActionResult,
  type ActionTone,
} from "@/lib/actions/payments";

const btn =
  "rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 transition-colors";

const TONE_STYLES: Record<ActionTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-slate-200 bg-slate-50 text-slate-700",
  error: "border-red-200 bg-red-50 text-red-800",
};

const TONE_ICONS: Record<ActionTone, string> = {
  success: "✓",
  info: "i",
  error: "!",
};

/**
 * The outcome of a money action, stated plainly. This is the only confirmation
 * an operator gets that a collection went through, so it must never be mistaken
 * for the prompt that asked them to confirm it.
 */
function ResultBanner({
  result,
  onDismiss,
}: {
  result: ActionResult;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-2 flex items-start gap-2 rounded-md border p-3 text-sm ${TONE_STYLES[result.tone]}`}
    >
      <span aria-hidden className="mt-px font-bold">
        {TONE_ICONS[result.tone]}
      </span>
      <span className="flex-1">{result.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 text-xs opacity-60 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

export function SetupLinkButton({ borrowerId }: { borrowerId: string }) {
  const [state, formAction, pending] = useActionState<SetupLinkState, FormData>(
    sendSetupLinkAction,
    null,
  );
  const [copied, setCopied] = useState(false);
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
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-slate-500">
              Share this single-use link (expires in 72h):
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(state.url!)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
              className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-100"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <code className="break-all text-slate-800">{state.url}</code>
          {state.emailed ? (
            <div className="mt-1 text-slate-500">Emailed to the borrower</div>
          ) : (
            <div className="mt-1 font-medium text-amber-800">
              {state.emailConfigured === false
                ? "Not emailed: email sending is not set up yet. Copy this link and send it to the borrower yourself."
                : "Not emailed. Copy this link and send it to the borrower yourself."}
            </div>
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
  const [dismissed, setDismissed] = useState(false);

  // Close the confirm prompt as soon as a result comes back. Leaving "Collect
  // £250 now? Confirm collection" on screen after the payment has been sent
  // invites the operator to press it again. Adjusting during render (rather
  // than in an effect) is React's documented way to react to a changed prop or
  // state value without an extra render pass.
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    setConfirming(false);
    setDismissed(false);
  }

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
      {state && !dismissed && (
        <ResultBanner result={state} onDismiss={() => setDismissed(true)} />
      )}
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
      {state && (
        <span
          role="status"
          aria-live="polite"
          className={`text-xs ${
            state.tone === "error"
              ? "text-red-700"
              : state.tone === "success"
                ? "text-emerald-700"
                : "text-slate-500"
          }`}
        >
          {state.message}
        </span>
      )}
    </span>
  );
}

/**
 * Collect an amount outside the repayment schedule: a late fee, a missed
 * payment being caught up, anything ad hoc.
 *
 * Kept separate from "Execute payment now" because the risk is different. That
 * button collects a known scheduled amount; this one collects whatever is typed,
 * so it asks for the figure and a short label the borrower will see on their
 * statement, and confirms the exact amount before sending.
 */
export function OneOffPaymentButton({
  borrowerId,
  nonce,
}: {
  borrowerId: string;
  nonce: string;
}) {
  const [openForm, setOpenForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    executePaymentNowAction,
    null,
  );
  const [dismissed, setDismissed] = useState(false);

  // Same render-time adjustment as ExecuteNowButton: close the form once a
  // result arrives so a sent payment never still looks like a pending question.
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    setDismissed(false);
    if (state?.tone === "success") {
      setOpenForm(false);
      setAmount("");
      setReason("");
    }
  }

  if (!openForm) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpenForm(true)}
          className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
        >
          Take a one-off payment
        </button>
        {state && !dismissed && (
          <ResultBanner result={state} onDismiss={() => setDismissed(true)} />
        )}
      </div>
    );
  }

  return (
    <div className="w-full">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="borrowerId" value={borrowerId} />
        <input type="hidden" name="nonce" value={nonce} />
        <label className="block">
          <span className="text-xs font-medium text-slate-700">Amount (£)</span>
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="75.00"
            className="mt-1 w-28 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-700">
            What is it for?
          </span>
          <input
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Late fee"
            className="mt-1 w-40 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Shows on their statement. Letters and numbers only.
          </span>
        </label>
        <button
          type="submit"
          disabled={pending || !amount}
          className={`${btn} bg-red-700 text-white hover:bg-red-600`}
        >
          {pending ? "Sending…" : `Collect £${amount || "0.00"} now`}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpenForm(false)}
          className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
        >
          Cancel
        </button>
      </form>
      {state && !dismissed && (
        <ResultBanner result={state} onDismiss={() => setDismissed(true)} />
      )}
    </div>
  );
}
