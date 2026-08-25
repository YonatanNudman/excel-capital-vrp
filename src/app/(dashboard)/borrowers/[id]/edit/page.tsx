import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getBorrower } from "@/lib/repo/borrowers";
import { listDestinations } from "@/lib/repo/destinations";
import { unprotectString } from "@/lib/crypto";
import { getEnv } from "@/lib/db";
import { updateBorrowerDetailsAction } from "@/lib/actions/borrowers";
import { BankLimitsForm } from "@/components/bank-limits-form";

export const dynamic = "force-dynamic";

export default async function EditBorrowerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const borrower = await getBorrower(db, id);
  if (!borrower) notFound();

  const env = getEnv();
  // Show the DEFAULT account, and its own mandate, so the bank details and the
  // limits on this page always describe the same account. Reading the newest
  // recipient alongside the default account's consent meant a borrower with two
  // accounts saw one account's sort code beside another's limits.
  const destinations = (await listDestinations(db, id)).filter(
    (d) => d.recipient && d.recipient.archived_at == null,
  );
  const target =
    destinations.find((d) => d.recipient!.is_default) ?? destinations[0] ?? null;
  const recipient = target?.recipient ?? null;
  const consent = target?.consent ?? null;
  const otherAccounts = Math.max(0, destinations.length - 1);
  const accountNumber = await unprotectString(recipient?.account_number, env.APP_ENCRYPTION_KEY);
  const sortCode = await unprotectString(recipient?.sort_code, env.APP_ENCRYPTION_KEY);
  const major = (minor: number | null | undefined) =>
    minor == null ? "" : (minor / 100).toFixed(2);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/borrowers/${id}`} className="text-sm text-slate-500 hover:underline">
        ← {borrower.legal_name}
      </Link>
      <h1 className="mt-1 mb-6 text-2xl font-semibold tracking-tight">
        Edit business details
      </h1>

      <form
        action={updateBorrowerDetailsAction}
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <input type="hidden" name="borrowerId" value={id} />
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Legal name *</span>
          <input
            name="legalName"
            required
            defaultValue={borrower.legal_name}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Company number</span>
          <input
            name="companyNumber"
            defaultValue={borrower.company_number ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Contact email</span>
          <input
            name="contactEmail"
            type="email"
            defaultValue={borrower.contact_email ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Contact phone</span>
          <input
            name="contactPhone"
            defaultValue={borrower.contact_phone ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <div className="flex justify-end gap-3">
          <Link
            href={`/borrowers/${id}`}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Save details
          </button>
        </div>
      </form>

      <h2 className="mt-8 mb-3 text-lg font-semibold tracking-tight">
        Bank details and payment limits
      </h2>
      {otherAccounts > 0 && (
        // Say which account this form edits. With more than one, an unlabelled
        // form is an invitation to change the wrong account's bank details.
        <p className="mb-3 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          This edits <strong>{recipient?.label?.trim() || recipient?.name || "the default account"}</strong>,
          the default account.{" "}
          {otherAccounts === 1 ? "There is 1 other account" : `There are ${otherAccounts} other accounts`}
          {" "}for this borrower: manage {otherAccounts === 1 ? "it" : "them"} under
          &ldquo;Where repayments are sent&rdquo; on the borrower page.
        </p>
      )}
      <BankLimitsForm
        borrowerId={id}
        locked={consent?.status === "authorized"}
        defaults={{
          recipientName: recipient?.name ?? "",
          accountNumber: accountNumber ?? "",
          sortCode: sortCode ?? "",
          maxPaymentAmount: major(consent?.max_payment_amount_minor),
          periodicMaxAmount: major(consent?.periodic_max_amount_minor),
          consentPeriod: consent?.period ?? "",
        }}
      />
    </div>
  );
}
