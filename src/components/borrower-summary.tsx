import { formatMinor } from "@/lib/money";
import type { LoanProgress } from "@/lib/loan-progress";
import type { RepaymentSchedule, SetupLink } from "@/lib/types";

/**
 * Answers "where is this loan up to" at the top of the borrower page.
 *
 * The client had to ask whether the total actually stops collections, because
 * every number here already existed in the database and appeared on no screen.
 * Each figure states its own arithmetic so none of it has to be taken on faith.
 */

function Stat({
  label,
  value,
  detail,
  tone = "normal",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "normal" | "good" | "warn";
}) {
  const valueCls = {
    normal: "text-slate-900",
    good: "text-emerald-700",
    warn: "text-amber-800",
  }[tone];
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${valueCls}`}>{value}</div>
      {detail && <div className="text-xs text-slate-500">{detail}</div>}
    </div>
  );
}

function setupLinkState(link: SetupLink | null): { label: string; detail: string } | null {
  if (!link) return null;
  if (link.used_at) {
    return { label: "Link used", detail: `Opened and completed ${link.used_at.slice(0, 10)}` };
  }
  const expired = new Date(link.expires_at) < new Date();
  if (expired) {
    return {
      label: "Link expired",
      detail: `Sent ${link.created_at.slice(0, 10)}, never used. Generate a new one.`,
    };
  }
  return {
    label: "Link waiting",
    detail: `Sent ${link.created_at.slice(0, 10)}, valid until ${link.expires_at.slice(0, 10)}`,
  };
}

export function BorrowerSummary({
  schedule,
  progress,
  latestLink,
  consentAuthorised,
}: {
  schedule: RepaymentSchedule | null;
  progress: LoanProgress;
  latestLink: SetupLink | null;
  consentAuthorised: boolean;
}) {
  const currency = schedule?.currency ?? "GBP";
  const linkState = setupLinkState(latestLink);

  // Until the borrower has authorised, the next collection date is fiction.
  const nextRun =
    consentAuthorised && schedule?.next_run_date && schedule.active
      ? schedule.next_run_date
      : null;

  return (
    <div className="mb-6 grid grid-cols-2 gap-5 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-4">
      <Stat
        label="Next collection"
        value={
          nextRun
            ? `${formatMinor(schedule!.amount_minor, currency)}`
            : consentAuthorised
              ? "None scheduled"
              : "Not yet"
        }
        detail={
          nextRun
            ? `on ${nextRun}`
            : consentAuthorised
              ? "No active schedule"
              : "Waiting for the borrower to authorise"
        }
      />

      <Stat
        label="Collected so far"
        value={formatMinor(progress.collectedMinor, currency)}
        detail={
          progress.paymentsMade === 1
            ? "1 payment taken"
            : `${progress.paymentsMade} payments taken`
        }
        tone={progress.collectedMinor > 0 ? "good" : "normal"}
      />

      <Stat
        label="Still to collect"
        value={
          progress.remainingMinor != null
            ? formatMinor(progress.remainingMinor, currency)
            : "Open ended"
        }
        detail={
          progress.targetMinor != null
            ? `of ${formatMinor(progress.targetMinor, currency)} total` +
              (progress.percent != null ? `, ${progress.percent}% done` : "")
            : "Runs until the end date, no fixed total"
        }
      />

      <Stat
        // Once the mandate exists, the link's own state is history and the label
        // should describe what matters now.
        label={consentAuthorised ? "Bank mandate" : linkState ? linkState.label : "Setup link"}
        value={
          consentAuthorised
            ? "Authorised"
            : linkState
              ? linkState.label === "Link expired"
                ? "Expired"
                : "Sent"
              : "Not sent"
        }
        detail={
          consentAuthorised
            ? "Bank mandate is active"
            : linkState
              ? linkState.detail
              : "Generate a setup link to get started"
        }
        tone={
          consentAuthorised
            ? "good"
            : linkState?.label === "Link expired"
              ? "warn"
              : "normal"
        }
      />
    </div>
  );
}
