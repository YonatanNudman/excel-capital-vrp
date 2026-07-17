import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getBorrower } from "@/lib/repo/borrowers";
import { updateBorrowerDetailsAction } from "@/lib/actions/borrowers";

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
    </div>
  );
}
