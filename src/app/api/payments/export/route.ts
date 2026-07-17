import { getDb } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";
import { listPayments } from "@/lib/repo/payments";
import { listBorrowers } from "@/lib/repo/borrowers";
import { writeAudit } from "@/lib/repo/audit";
import { fromMinorUnits } from "@/lib/money";
import { csvCell as csv } from "@/lib/csv";

export const dynamic = "force-dynamic";

/** Reconciliation export of all payments (any staff role; audited). */
export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const status = e instanceof AuthError && e.code === "forbidden" ? 403 : 401;
    return new Response("Not authorised", { status });
  }

  const db = getDb();
  const [payments, borrowers] = await Promise.all([
    listPayments(db, { limit: 500 }),
    listBorrowers(db, {}),
  ]);
  const nameById = new Map(borrowers.map((b) => [b.id, b.legal_name]));

  const header = [
    "created_at",
    "borrower",
    "amount",
    "currency",
    "reference",
    "status",
    "scheduled_for",
    "failure_reason",
    "plaid_payment_id",
    "payment_id",
  ].join(",");
  const rows = payments.map((p) =>
    [
      csv(p.created_at),
      csv(nameById.get(p.borrower_id) ?? p.borrower_id),
      csv(fromMinorUnits(p.amount_minor).toFixed(2)),
      csv(p.currency),
      csv(p.reference),
      csv(p.status),
      csv(p.scheduled_for),
      csv(p.failure_reason),
      csv(p.plaid_payment_id),
      csv(p.id),
    ].join(","),
  );

  await writeAudit(db, {
    actorStaffId: user.id,
    action: "payments.export",
    entityType: "payments",
    entityId: null,
    metadata: { rows: rows.length },
  });

  const today = new Date().toISOString().slice(0, 10);
  return new Response([header, ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="excel-capital-payments-${today}.csv"`,
    },
  });
}
