import { formatMinor } from "@/lib/money";
import type { LoanProgress } from "@/lib/loan-progress";
import type { SetupProgress } from "@/lib/setup-progress";
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
  setup,
}: {
  schedule: RepaymentSchedule | null;
  progress: LoanProgress;
  latestLink: SetupLink | null;
  /** What the borrower still has to do, across every account they were sent. */
  setup: SetupProgress;
}) {
  const currency = schedule?.currency ?? "GBP";
  const linkState = setupLinkState(latestLink);
  // At least one mandate is live, so money can move.
  const consentAuthorised = setup.approved > 0;

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
        // The one stat that answers "has the client done everything their end".
        // It used to read "Authorised" off a single mandate, which quietly became
        // wrong once a borrower could hold several: one approved account showed
        // the same green "Authorised" as a borrower who had approved every one,
        // with a second account still waiting on them and nothing saying so.
        //
        // Once anything is approved the link's own state is history, EXCEPT while
        // something is still outstanding, when whether a usable link is in their
        // hands is precisely what an operator needs to know.
        label="Borrower's side"
        value={
          setup.complete
            ? "All approved"
            : setup.total === 0
              ? "Nothing to do yet"
              : setup.awaitingBorrower > 0
                ? linkState?.label === "Link expired"
                  ? "Link expired"
                  : linkState
                    ? "Waiting on them"
                    : "Link not sent"
                : "Waiting on you"
        }
        detail={
          setup.complete || setup.total === 0 || setup.awaitingBorrower === 0
            ? setup.detail
            : linkState
              ? `${setup.detail} ${linkState.detail}.`
              : `${setup.detail} No setup link has been sent yet.`
        }
        tone={setup.complete ? "good" : setup.total === 0 ? "normal" : "warn"}
      />
    </div>
  );
}
