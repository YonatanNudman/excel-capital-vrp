"use client";

import { useActionState } from "react";
import {
  requestAccessAction,
  type RequestAccessState,
} from "@/lib/actions/access-requests";

/**
 * Shown to somebody Cloudflare has authenticated but who is not staff yet.
 *
 * Replaces a dead-end "Not authorised" screen. Shows no borrower data and no
 * navigation, so an unapproved visitor learns nothing except that the place
 * exists and somebody will look at their request.
 */
export function RequestAccess({
  email,
  alreadyRequested,
  denied,
}: {
  email: string;
  alreadyRequested: boolean;
  denied: boolean;
}) {
  const [state, formAction, pending] = useActionState<RequestAccessState, FormData>(
    requestAccessAction,
    null,
  );

  if (denied) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-semibold">No access</h1>
        <p className="text-sm text-slate-600">
          This account cannot use the platform. If you think that is a mistake,
          speak to Excel Capital directly.
        </p>
      </main>
    );
  }

  if (state?.submitted || alreadyRequested) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-semibold">Request sent</h1>
        <p className="text-sm text-slate-600">
          Someone at Excel Capital will review it. You will be able to sign in
          once they approve you. Nothing more to do for now.
        </p>
        <p className="text-xs text-slate-500">Signed in as {email}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <div>
        <h1 className="text-xl font-semibold">Ask for access</h1>
        <p className="mt-1 text-sm text-slate-600">
          You are signed in as <span className="font-medium">{email}</span>, but
          you do not have access yet. Send a request and someone at Excel Capital
          will approve or decline it.
        </p>
      </div>
      <form action={formAction} className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            Anything they should know? (optional)
          </span>
          <textarea
            name="note"
            rows={3}
            maxLength={500}
            placeholder="e.g. I am the new bookkeeper, Barry asked me to get set up"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send request"}
        </button>
      </form>
    </main>
  );
}
