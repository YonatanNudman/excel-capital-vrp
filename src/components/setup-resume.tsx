"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { completeSetupAction, type CompleteState } from "@/lib/actions/setup-complete";
import { SETUP_RESUME_KEY } from "@/components/setup-launcher";

const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

/**
 * Finish an authorisation that went out to the borrower's bank and came back.
 *
 * Real banks do not authorise inside our page. Plaid sends the borrower to the
 * bank's own site, and the bank returns them to the redirect_uri we registered,
 * which is this page. Link has to be re-created here with the SAME link token
 * plus receivedRedirectUri before it will report the result.
 *
 * Without this page the borrower authorised successfully at their bank and then
 * landed on "Link invalid or expired", because /setup/complete fell through to
 * the /setup/[token] route with "complete" read as their token. Plaid recorded a
 * success and we recorded nothing.
 */
export function SetupResume() {
  const [state, formAction, pending] = useActionState<CompleteState, FormData>(
    completeSetupAction,
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const started = useRef(false);

  useEffect(() => {
    // Runs once: re-opening Link twice would show the borrower two dialogs.
    if (started.current) return;
    started.current = true;

    // Wrapped in an async step on purpose. sessionStorage can only be read after
    // mount, and setting state straight from an effect body triggers a cascading
    // render; deferring by a microtask keeps the one-shot read out of that path.
    void (async () => {
    await Promise.resolve();
    let stored: { linkToken?: string; token?: string } | null = null;
    try {
      const raw = sessionStorage.getItem(SETUP_RESUME_KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }

    if (!stored?.linkToken || !stored.token) {
      // Different browser, cleared storage, or private browsing. Their bank may
      // well have approved it, so do not imply they failed.
      setProblem(
        "We could not finish this automatically. Please reopen the setup link Excel Capital sent you. If your bank already confirmed, contact Excel Capital and they can check.",
      );
      return;
    }
    setSetupToken(stored.token);

    const finish = () => {
      const handler = window.Plaid?.create({
        token: stored!.linkToken!,
        receivedRedirectUri: window.location.href,
        onSuccess: () => {
          try {
            sessionStorage.removeItem(SETUP_RESUME_KEY);
          } catch {
            /* nothing to clean up */
          }
          formRef.current?.requestSubmit();
        },
        onExit: (err) => {
          if (!err) return;
          console.error("plaid oauth resume failed", err);
          setProblem(
            err.display_message ||
              err.error_message ||
              "Your bank could not complete this authorisation. Please try the setup link again.",
          );
        },
      });
      if (!handler) {
        setProblem("We could not finish this automatically. Please reopen your setup link.");
        return;
      }
      handler.open();
    };

    if (window.Plaid) {
      finish();
      return;
    }
    const s = document.createElement("script");
    s.src = PLAID_SCRIPT;
    s.onload = finish;
    s.onerror = () =>
      setProblem(
        "We could not load your bank connection. If you use an ad blocker or private browsing, try again in a normal browser window.",
      );
    document.body.appendChild(s);
    })();
  }, []);

  if (state?.done) {
    return (
      <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{state.message}</div>
    );
  }

  return (
    <div>
      <form ref={formRef} action={formAction}>
        <input type="hidden" name="token" value={setupToken ?? ""} />
      </form>
      {!problem && !state && (
        <p className="text-sm text-slate-600">
          {pending ? "Confirming with your bank…" : "Finishing your authorisation…"}
        </p>
      )}
      {problem && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {problem}
        </p>
      )}
      {state && !state.done && (
        <p className="mt-2 text-sm text-red-600">{state.message}</p>
      )}
    </div>
  );
}
