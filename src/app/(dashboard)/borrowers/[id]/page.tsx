import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, getEnv } from "@/lib/db";
import { unprotectString } from "@/lib/crypto";
import { getBorrower } from "@/lib/repo/borrowers";
import { getActiveConsent } from "@/lib/repo/consents";
import { getActiveSchedule, isStoredDaily, parseDaysOfWeek } from "@/lib/repo/schedules";
import { getRecipient } from "@/lib/repo/recipients";
import { listPaymentsForBorrower, collectionProgress } from "@/lib/repo/payments";
import { latestSetupLinkForBorrower } from "@/lib/repo/setup-links";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { setBorrowerStatusAction } from "@/lib/actions/borrowers";
import { StatusBadge } from "@/components/status-badge";
import {
  ExecuteNowButton,
  OneOffPaymentButton,
  RetryButton,
  SetupLinkButton,
} from "@/components/action-buttons";
import { formatMinor } from "@/lib/money";
import { setupReadiness } from "@/lib/readiness";
import { loanProgress, paymentKind } from "@/lib/loan-progress";
import { BorrowerSummary } from "@/components/borrower-summary";
import { PaymentKindTag } from "@/components/payment-kind-tag";
import type { RepaymentSchedule } from "@/lib/types";

export const dynamic = "force-dynamic";

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{value ?? "-"}</span>
    </div>
  );
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scheduleSummary(s: RepaymentSchedule): string {
  // A daily schedule is stored as custom/1-day plus a weekday list, so describe
  // it as daily rather than as "every 1 days" (see migrations/0004).
  let freq: string;
  if (isStoredDaily(s)) {
    const days = parseDaysOfWeek(s.days_of_week) ?? [];
    freq =
      days.length === 7
        ? "daily"
        : `daily on ${days.map((d) => DAY_LABELS[d - 1]).join(", ")}`;
  } else {
    freq = s.frequency === "custom" ? `every ${s.interval_days ?? "?"} days` : s.frequency;
  }
  let end = "";
  if (s.end_mode === "count") end = `for ${s.end_count ?? "?"} payments`;
  else if (s.end_mode === "date") end = `until ${s.end_date ?? "?"}`;
  else if (s.end_mode === "total")
    end = `until ${formatMinor(s.end_total_minor ?? 0, s.currency)} collected`;
  return `${formatMinor(s.amount_minor, s.currency)} ${freq}, ${end}`;
}

export default async function BorrowerProfile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const borrower = await getBorrower(db, id);
  if (!borrower) notFound();

  const [consent, schedule, recipient, payments, user, latestLink] = await Promise.all([
    getActiveConsent(db, id),
    getActiveSchedule(db, id),
    getRecipient(db, id),
    listPaymentsForBorrower(db, id, 50),
    getCurrentUser(),
    latestSetupLinkForBorrower(db, id),
  ]);
  const progress = loanProgress({
    schedule,
    ...(await collectionProgress(db, id, schedule?.id)),
  });
  const canOperate = user ? hasRole(user, "operator") : false;
  const paused = borrower.status === "paused";
  // Surface an incomplete setup here rather than letting the borrower hit it.
  const readiness = setupReadiness(recipient, consent);
  const env = getEnv();
  const accountNumber = await unprotectString(recipient?.account_number, env.APP_ENCRYPTION_KEY);
  const sortCode = await unprotectString(recipient?.sort_code, env.APP_ENCRYPTION_KEY);

  return (
    <div>
      <div className="mb-6">
        <Link href="/borrowers" className="text-sm text-slate-500 hover:underline">
          ← Borrowers
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{borrower.legal_name}</h1>
          <StatusBadge status={borrower.status} />
        </div>
      </div>

      <BorrowerSummary
        schedule={schedule}
        progress={progress}
        latestLink={latestLink}
        consentAuthorised={consent?.status === "authorized"}
      />

      {canOperate && !readiness.ready && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            Not ready to send to the borrower yet
          </h2>
          <p className="mt-1 text-sm text-amber-900">
            The borrower cannot connect their bank until these are filled in.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {readiness.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <Link
            href={`/borrowers/${borrower.id}/edit`}
            className="mt-3 inline-block rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800"
          >
            Fill these in
          </Link>
        </div>
      )}

      {canOperate && (
        <div className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <ExecuteNowButton
            borrowerId={borrower.id}
            nonce={crypto.randomUUID()}
            amountLabel={schedule ? formatMinor(schedule.amount_minor, schedule.currency) : "the entered amount"}
          />
          <SetupLinkButton borrowerId={borrower.id} />
          <OneOffPaymentButton borrowerId={borrower.id} nonce={crypto.randomUUID()} />
          <form action={setBorrowerStatusAction}>
            <input type="hidden" name="borrowerId" value={borrower.id} />
            <input type="hidden" name="status" value={paused ? "active" : "paused"} />
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              {paused ? "Resume collections" : "Pause collections"}
            </button>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="Business"
          action={
            canOperate ? (
              <Link href={`/borrowers/${borrower.id}/edit`} className="text-xs text-slate-500 hover:underline">
                Edit
              </Link>
            ) : undefined
          }
        >
          <Row label="Legal name" value={borrower.legal_name} />
          <Row label="Company number" value={borrower.company_number} />
          <Row label="Contact email" value={borrower.contact_email} />
          <Row label="Contact phone" value={borrower.contact_phone} />
          <Row
            label="Registered office"
            value={borrower.registered_address}
          />
        </Card>

        <Card title="Recipient">
          <Row label="Account name" value={recipient?.name} />
          <Row label="Account number" value={maskAccount(accountNumber)} />
          <Row label="Sort code" value={maskSortCode(sortCode)} />
          <Row label="Plaid recipient" value={recipient?.plaid_recipient_id ? "linked" : "not yet"} />
        </Card>

        <Card title="Consent">
          <Row label="Status" value={consent ? <StatusBadge status={consent.status} /> : "none"} />
          <Row
            label="Max per payment"
            value={consent?.max_payment_amount_minor != null
              ? formatMinor(consent.max_payment_amount_minor, consent.currency)
              : null}
          />
          <Row
            label="Max per period"
            value={consent?.periodic_max_amount_minor != null
              ? `${formatMinor(consent.periodic_max_amount_minor, consent.currency)} / ${consent.period ?? "?"}`
              : null}
          />
          <Row label="Valid to" value={consent?.valid_to} />
        </Card>

        <Card
          title="Schedule"
          action={
            canOperate ? (
              <Link href={`/borrowers/${borrower.id}/schedule`} className="text-xs text-slate-500 hover:underline">
                Edit
              </Link>
            ) : undefined
          }
        >
          {schedule ? (
            <>
              <p className="text-sm text-slate-800">{scheduleSummary(schedule)}</p>
              <Row label="Next run" value={schedule.next_run_date} />
            </>
          ) : (
            <p className="text-sm text-slate-400">No active schedule.</p>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <Card title="Payment history">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Amount</th>
                  <th className="py-2 font-medium">What for</th>
                  <th className="py-2 font-medium">Reference</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-400">
                      No payments yet.
                    </td>
                  </tr>
                )}
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 text-slate-600">{p.created_at.slice(0, 10)}</td>
                    <td className="py-2 font-medium">{formatMinor(p.amount_minor, p.currency)}</td>
                    <td className="py-2"><PaymentKindTag kind={paymentKind(p)} /></td>
                    <td className="py-2 text-slate-600">{p.reference ?? "-"}</td>
                    <td className="py-2">
                      <StatusBadge status={p.status} />
                      {p.status === "unknown" && (
                        <span className="ml-2 text-xs text-amber-700">Confirming with bank; do not retry</span>
                      )}
                      {p.failure_reason && (p.status === "failed" || p.status === "rejected") && (
                        <span className="ml-2 text-xs text-red-500">{p.failure_reason}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {canOperate && p.status === "failed" && <RetryButton paymentId={p.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

function maskAccount(value: string | null): string | null {
  return value ? `••••${value.replace(/\D/g, "").slice(-4)}` : null;
}

function maskSortCode(value: string | null): string | null {
  return value ? `••-••-${value.replace(/\D/g, "").slice(-2)}` : null;
}
