const COLORS: Record<string, string> = {
  // borrower
  onboarding: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  paused: "bg-slate-200 text-slate-700",
  revoked: "bg-red-100 text-red-800",
  expired: "bg-red-100 text-red-800",
  // consent
  pending: "bg-amber-100 text-amber-800",
  authorized: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  // payment
  submitted: "bg-sky-100 text-sky-800",
  initiated: "bg-sky-100 text-sky-800",
  executed: "bg-indigo-100 text-indigo-800",
  settled: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-700",
};

export function StatusBadge({ status }: { status: string }) {
  const cls = COLORS[status] ?? "bg-slate-200 text-slate-700";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {status}
    </span>
  );
}
