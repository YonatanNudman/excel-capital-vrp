import type { PaymentKind } from "@/lib/loan-progress";

/**
 * Says what a payment was for, in the operator's language.
 *
 * Without it a £75 late fee and a £500 scheduled collection are only
 * distinguishable by squinting at the reference string.
 */
const STYLES: Record<PaymentKind, { label: string; cls: string; title: string }> = {
  scheduled: {
    label: "Scheduled",
    cls: "bg-slate-100 text-slate-700",
    title: "Part of the repayment plan, collected automatically",
  },
  "one-off": {
    label: "One-off",
    cls: "bg-sky-100 text-sky-800",
    title: "Taken outside the plan, for example a late fee",
  },
  retry: {
    label: "Retry",
    cls: "bg-amber-100 text-amber-900",
    title: "Another attempt at a payment that failed",
  },
};

export function PaymentKindTag({ kind }: { kind: PaymentKind }) {
  const s = STYLES[kind];
  return (
    <span
      title={s.title}
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
