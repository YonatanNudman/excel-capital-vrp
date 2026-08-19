import { getDb } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";
import { listAudit } from "@/lib/repo/audit";
import { listStaff } from "@/lib/repo/staff";
import { writeAudit } from "@/lib/repo/audit";
import { csvCell as csv } from "@/lib/csv";

export const dynamic = "force-dynamic";

/** Full export of audit log (any staff role; audited). */
export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const status = e instanceof AuthError && e.code === "forbidden" ? 403 : 401;
    return new Response("Not authorised", { status });
  }
  
  const db = getDb();
  const [entries, staff] = await Promise.all([
    listAudit(db, { limit: 500 }),
    listStaff(db),
  ]);
  const emailById = new Map(staff.map((s) => [s.id, s.email]));

  const header = [
    "created_at",
    "actor",
    "action",
    "entity_type",
    "entity_id",
    "metadata",
  ].join(",");
  const rows = entries.map((e) =>
    [
      csv(e.created_at),
      csv(e.actor_staff_id ? emailById.get(e.actor_staff_id) ?? "-" : "system"),
      csv(e.action),
      csv(e.entityType),
      csv(e.entityId),
      csv(e.metadata),
    ].join(","),
  );

  await writeAudit(db, {
    actorStaffId: user.id,
    action: "audit.export",
    entityType: "audit_log",
    entityId: null,
    metadata: { rows: rows.length },
  });

  const today = new Date().toISOString().slice(0, 10);
  return new Response([header, ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="excel-capital-audit_log-${today}.csv"`,
    },
  });
}
