"use client";

import { useActionState, useCallback, useState } from "react";
import { completeSetupAction, type CompleteState } from "@/lib/actions/setup-complete";

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess: () => void;
        onExit?: () => void;
      }): { open: () => void };
    };
  }
}

const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export function SetupLauncher({
  token,
  linkToken,
  mode,
}: {
  token: string;
  linkToken: string;
  mode: "real" | "mock";
}) {
  const [state, formAction, pending] = useActionState<CompleteState, FormData>(
    completeSetupAction,
    null,
  );
  const [launching, setLaunching] = useState(false);

  // Real Plaid Link: load the SDK on demand, open with the link token, and on
  // success submit the completion form. Not exercised until real credentials
  // exist, but wired so it works once they do.
  const openPlaid = useCallback(
    (submit: () => void) => {
      setLaunching(true);
      const start = () => {
        const handler = window.Plaid?.create({
          token: linkToken,
          onSuccess: () => submit(),
          onExit: () => setLaunching(false),
        });
        handler?.open();
      };
      if (window.Plaid) {
        start();
      } else {
        const s = document.createElement("script");
        s.src = PLAID_SCRIPT;
        s.onload = start;
        document.body.appendChild(s);
      }
    },
    [linkToken],
  );

  if (state?.done) {
    return (
      <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
        {state.message}
      </div>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="token" value={token} />
      {mode === "mock" ? (
        <>
          <div className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
            Sandbox mode: Plaid credentials are not configured, so this simulates
            a successful authorisation for testing.
          </div>
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {pending ? "Confirming…" : "Simulate authorisation"}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={pending || launching}
          onClick={(e) => {
            const form = e.currentTarget.closest("form") as HTMLFormElement;
            openPlaid(() => form.requestSubmit());
          }}
          className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {launching ? "Opening Plaid…" : "Connect your bank"}
        </button>
      )}
      {state && !state.done && (
        <p className="mt-2 text-sm text-red-600">{state.message}</p>
      )}
    </form>
  );
}
