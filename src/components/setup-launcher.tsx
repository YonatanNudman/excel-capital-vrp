"use client";

import { useActionState, useCallback, useState } from "react";
import { completeSetupAction, type CompleteState } from "@/lib/actions/setup-complete";

/**
 * Plaid calls onExit with (error, metadata). The previous declaration here was
 * `() => void`, so the error was accepted and silently discarded: Plaid was
 * reporting exactly what had gone wrong and nothing ever looked at it.
 */
interface PlaidError {
  error_code?: string;
  error_message?: string;
  display_message?: string;
}

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess: () => void;
        onExit?: (err: PlaidError | null, metadata?: unknown) => void;
        onEvent?: (eventName: string, metadata?: unknown) => void;
        receivedRedirectUri?: string;
      }): { open: () => void };
    };
  }
}

const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

/** Shared with the /setup/complete page, which resumes the flow after a bank redirect. */
export const SETUP_RESUME_KEY = "excel-capital-setup-resume";

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
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Open Plaid Link, and make every failure visible.
   *
   * Borrowers reported "I click Connect your bank and nothing happens". Every
   * failure path here used to be silent: the script tag had no onerror, create()
   * was not guarded, and the error Plaid passes to onExit was discarded. A dead
   * button tells the borrower nothing and tells us less, so each one now says
   * what went wrong and leaves the button usable for another try.
   */
  const openPlaid = useCallback(
    (submit: () => void) => {
      setProblem(null);
      setLaunching(true);

      const failed = (message: string, detail?: unknown) => {
        // Logged as well as shown: the borrower gets plain words, and whoever
        // helps them can read the provider's own wording in the console.
        console.error("plaid link failed", message, detail);
        setProblem(message);
        setLaunching(false);
      };

      // Banks take the borrower away to their own site and send them back to
      // /setup/complete. Link can only be resumed there if it is given the SAME
      // link token, and that page has no other way to know it, so stash it now.
      try {
        sessionStorage.setItem(
          SETUP_RESUME_KEY,
          JSON.stringify({ linkToken, token }),
        );
      } catch {
        // Private browsing can refuse storage. The in-page flow still works; only
        // a bank that redirects away would be affected, and that is reported there.
      }

      const start = () => {
        if (!window.Plaid) {
          failed(
            "Your bank connection could not start. Please check your internet connection and try again.",
          );
          return;
        }
        try {
          const handler = window.Plaid.create({
            token: linkToken,
            onSuccess: () => submit(),
            onExit: (err) => {
              setLaunching(false);
              if (!err) return; // The borrower simply closed it; not a failure.
              failed(
                err.display_message ||
                  err.error_message ||
                  "Your bank could not complete this authorisation. Please try again, or contact Excel Capital.",
                err,
              );
            },
            onEvent: (eventName, metadata) => {
              if (eventName === "ERROR") console.error("plaid link error", metadata);
            },
          });
          if (!handler) {
            failed("Your bank connection could not start. Please try again.");
            return;
          }
          handler.open();
        } catch (e) {
          failed(
            "Your bank connection could not start. Please try again, or contact Excel Capital.",
            e,
          );
        }
      };

      if (window.Plaid) {
        start();
        return;
      }

      const s = document.createElement("script");
      s.src = PLAID_SCRIPT;
      s.onload = start;
      // Without this, a blocked or failed script left the button stuck on
      // "Opening Plaid…" forever with no explanation. Ad and tracker blockers do
      // block this CDN, which is a very ordinary thing for a phone to be doing.
      s.onerror = () =>
        failed(
          "Your bank connection could not load. If you use an ad blocker or private browsing, try again in a normal browser window.",
        );
      document.body.appendChild(s);
    },
    [linkToken, token],
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
      {problem && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {problem}
        </p>
      )}
      {state && !state.done && (
        <p className="mt-2 text-sm text-red-600">{state.message}</p>
      )}
    </form>
  );
}
