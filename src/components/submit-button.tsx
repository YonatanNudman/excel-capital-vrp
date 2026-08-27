"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that disables itself while the form is in flight.
 *
 * Without it, a second click during the first submit runs the action twice. That
 * created two identical borrowers on production 2.8 seconds apart, from one
 * person pressing the button once as far as they were concerned.
 *
 * This is the comfort, not the guarantee: a retried request or a back button can
 * still submit twice, so the action itself refuses a duplicate as well.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
