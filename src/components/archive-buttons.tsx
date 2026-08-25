"use client";

import { useActionState, useState } from "react";
import {
  archiveBorrowerAction,
  restoreBorrowerAction,
  type ArchiveState,
} from "@/lib/actions/archive";

const btn = "rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50";

function Result({ state }: { state: ArchiveState }) {
  if (!state) return null;
  return (
    <p
      role="status"
      className={`mt-2 rounded-md p-3 text-sm ${
        state.tone === "error" ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-900"
      }`}
    >
      {state.message}
    </p>
  );
}

/**
 * Archive, never delete. The word matters: staff should not expect the records to
 * disappear, because they do not and must not.
 */
export function ArchiveBorrowerButton({
  borrowerId,
  borrowerName,
}: {
  borrowerId: string;
  borrowerName: string;
}) {
  const [state, formAction, pending] = useActionState<ArchiveState, FormData>(
    archiveBorrowerAction,
    null,
  );
  const [confirming, setConfirming] = useState(false);

  // Close the prompt once a result arrives, so a finished action never still
  // looks like a pending question.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    setConfirming(false);
  }

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="borrowerId" value={borrowerId} />
        {confirming ? (
          <>
            <span className="text-sm text-slate-700">
              Archive {borrowerName}? They are hidden from the list, and all their
              records are kept.
            </span>
            <button type="submit" disabled={pending} className={`${btn} bg-slate-900 text-white hover:bg-slate-700`}>
              {pending ? "Archiving…" : "Yes, archive"}
            </button>
            <button
              type="button"
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
            className={`${btn} border border-slate-300 bg-white hover:bg-slate-50`}
          >
            Archive borrower
          </button>
        )}
      </form>
      <Result state={state} />
    </div>
  );
}

export function RestoreBorrowerButton({ borrowerId }: { borrowerId: string }) {
  const [state, formAction, pending] = useActionState<ArchiveState, FormData>(
    restoreBorrowerAction,
    null,
  );
  return (
    <span className="inline-flex items-center gap-2">
      <form action={formAction}>
        <input type="hidden" name="borrowerId" value={borrowerId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {pending ? "…" : "Restore"}
        </button>
      </form>
      {state && (
        <span className={`text-xs ${state.tone === "error" ? "text-red-700" : "text-emerald-700"}`}>
          {state.message}
        </span>
      )}
    </span>
  );
}
