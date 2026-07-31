import type { Borrower, BorrowerStatus } from "@/lib/types";
import { newId } from "@/lib/ids";

export interface BorrowerListFilter {
  search?: string;
  status?: BorrowerStatus | "all";
}

export async function listBorrowers(
  db: D1Database,
  filter: BorrowerListFilter = {},
): Promise<Borrower[]> {
  let sql = "SELECT * FROM borrowers WHERE deleted_at IS NULL";
  const binds: unknown[] = [];

  if (filter.status && filter.status !== "all") {
    sql += " AND status = ?";
    binds.push(filter.status);
  }
  if (filter.search && filter.search.trim()) {
    const q = `%${filter.search.trim().toLowerCase()}%`;
    sql += " AND (LOWER(legal_name) LIKE ? OR LOWER(company_number) LIKE ?)";
    binds.push(q, q);
  }
  sql += " ORDER BY created_at DESC";

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Borrower>();
  return results ?? [];
}

export async function getBorrower(
  db: D1Database,
  id: string,
): Promise<Borrower | null> {
  return db
    .prepare("SELECT * FROM borrowers WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<Borrower>();
}

export async function createBorrower(
  db: D1Database,
  data: {
    legalName: string;
    companyNumber?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    registeredAddress?: string | null;
    registeredPostcode?: string | null;
    createdBy: string | null;
  },
): Promise<Borrower> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO borrowers
         (id, legal_name, company_number, contact_email, contact_phone,
          registered_address, registered_postcode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      data.legalName,
      data.companyNumber ?? null,
      data.contactEmail ?? null,
      data.contactPhone ?? null,
      data.registeredAddress ?? null,
      data.registeredPostcode ?? null,
      data.createdBy,
    )
    .run();
  const created = await getBorrower(db, id);
  if (!created) throw new Error("failed to create borrower");
  return created;
}

export async function updateBorrower(
  db: D1Database,
  id: string,
  data: Partial<{
    legalName: string;
    companyNumber: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (data.legalName !== undefined) {
    sets.push("legal_name = ?");
    binds.push(data.legalName);
  }
  if (data.companyNumber !== undefined) {
    sets.push("company_number = ?");
    binds.push(data.companyNumber);
  }
  if (data.contactEmail !== undefined) {
    sets.push("contact_email = ?");
    binds.push(data.contactEmail);
  }
  if (data.contactPhone !== undefined) {
    sets.push("contact_phone = ?");
    binds.push(data.contactPhone);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await db
    .prepare(`UPDATE borrowers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function setBorrowerStatus(
  db: D1Database,
  id: string,
  status: BorrowerStatus,
): Promise<void> {
  await db
    .prepare("UPDATE borrowers SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

export async function softDeleteBorrower(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare("UPDATE borrowers SET deleted_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}
