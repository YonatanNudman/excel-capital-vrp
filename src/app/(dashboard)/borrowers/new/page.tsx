import Link from "next/link";
import { createBorrowerAction } from "@/lib/actions/borrowers";

import { WeekdayPicker } from "@/components/weekday-picker";
import { CompanyLookup } from "@/components/company-lookup";
import { CeilingSuggester } from "@/components/ceiling-suggester";
import { isCompaniesHouseConfigured } from "@/lib/companies-house";
import { getEnv } from "@/lib/db";

export const dynamic = "force-dynamic";

function Field({
  label,
  name,
  type = "text",
  placeholder,
  help,
  required,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        step={type === "number" ? "0.01" : undefined}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
      />
      {help && <span className="mt-0.5 block text-xs text-slate-400">{help}</span>}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export default function NewBorrowerPage() {
  // Only offer the register lookup when an API key is configured; otherwise the
  // form is plain manual entry.
  const companiesHouseReady = isCompaniesHouseConfigured(getEnv());
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link href="/borrowers" className="text-sm text-slate-500 hover:underline">
          ← Borrowers
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Onboard borrower</h1>
        <p className="mt-1 text-sm text-slate-500">
          Capture the business, where repayments are sent, the schedule, and the
          intended VRP consent limits. Consent limits are applied when the borrower
          authorises via Plaid.
        </p>
      </div>

      <form action={createBorrowerAction} className="space-y-5">
        <Section title="Business">
          {companiesHouseReady && <CompanyLookup />}
          <Field label="Legal name" name="legalName" required placeholder="Acme Trading Ltd" />
          <Field label="Company number" name="companyNumber" placeholder="12345678" />
          <Field label="Contact email" name="contactEmail" type="email" />
          <Field label="Contact phone" name="contactPhone" />
        </Section>

        <Section title="Recipient">
          <Field label="Account name" name="recipientName" required placeholder="Excel Capital Group Ltd" />
          <Field label="Account number" name="recipientAccount" required placeholder="12345678" />
          <Field label="Sort code" name="recipientSort" required placeholder="12-34-56" />
        </Section>

        <Section title="Repayment schedule">
          <Field label="Amount (£)" name="amount" type="number" required placeholder="500.00" />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Frequency</span>
            <select
              name="frequency"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="daily">Daily (choose which days below)</option>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom (every N days)</option>
            </select>
          </label>
          <div className="col-span-2">
            <WeekdayPicker selected={null} />
          </div>
          <Field label="Interval days (custom only)" name="intervalDays" type="number" />
          <Field label="Start date" name="startDate" type="date" required />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">End mode</span>
            <select
              name="endMode"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="count">After N payments</option>
              <option value="date">On a fixed date</option>
              <option value="total">When a total is collected</option>
            </select>
          </label>
          <Field label="End: number of payments" name="endCount" type="number" help="For 'After N payments'" />
          <Field label="End: date" name="endDate" type="date" help="For 'On a fixed date'" />
          <Field label="End: total (£)" name="endTotal" type="number" help="For 'When a total is collected'" />
        </Section>

        <Section title="VRP consent limits">
          <CeilingSuggester />
          <Field label="Ceiling for any single payment (£)" name="maxPaymentAmount" type="number" required placeholder="600.00" />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">The period is</span>
            <select
              name="consentPeriod"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">None</option>
              <option value="DAY">Day</option>
              <option value="WEEK">Week</option>
              <option value="MONTH">Month</option>
              <option value="YEAR">Year</option>
            </select>
          </label>
          <Field label="Ceiling across the whole period (£)" name="periodicMaxAmount" type="number" required placeholder="2400.00" />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Alignment</span>
            <select
              name="consentAlignment"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="CALENDAR">Calendar</option>
              <option value="CONSENT">Consent</option>
            </select>
          </label>
          <Field label="Valid from" name="consentValidFrom" type="datetime-local" />
          <Field label="Valid to" name="consentValidTo" type="datetime-local" />
        </Section>

        <div className="flex justify-end gap-2">
          <Link
            href="/borrowers"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Create borrower
          </button>
        </div>
      </form>
    </div>
  );
}
