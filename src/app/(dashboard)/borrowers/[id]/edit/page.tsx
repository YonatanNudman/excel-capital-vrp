import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getBorrower } from "@/lib/repo/borrowers";
import { getRecipient } from "@/lib/repo/recipients";
import { getActiveConsent } from "@/lib/repo/consents";
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
  const [recipient, consent] = await Promise.all([
    getRecipient(db, id),
    getActiveConsent(db, id),
  ]);
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
