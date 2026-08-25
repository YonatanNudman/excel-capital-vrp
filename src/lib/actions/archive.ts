"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { writeAudit } from "@/lib/repo/audit";
import {
  archiveBlockers,
  archiveBorrower,
  getBorrowerIncludingArchived,
  restoreBorrower,
} from "@/lib/repo/borrowers";

export type ArchiveState = { message: string; tone: "success" | "error" } | null;

/**
 * Archive a borrower: hide them from the list, keep every record.
 *
 * Deliberately not a delete, and the UI never offers one. Payments, consents and
 * audit rows all point at the borrower, so deleting would take the payment
 * history with it, and a lender has to be able to say what it collected from
 * whom years later.
 */
export async function archiveBorrowerAction(
  _prev: ArchiveState,
  fd: FormData,
): Promise<ArchiveState> {
  const user = await requireRole("operator");
  const db = getDb();
  const borrowerId = String(fd.get("borrowerId") ?? "");
  if (!borrowerId) return { message: "Something went wrong: no borrower was selected.", tone: "error" };

  const borrower = await getBorrowerIncludingArchived(db, borrowerId);
  if (!borrower) return { message: "That borrower no longer exists.", tone: "error" };

  // Archiving hides a borrower, it does NOT stop collecting from them: the
  // nightly sweep works from schedules, not from the list. Hiding someone whose
  // money is still being taken is how a repayment stops being watched, so refuse
  // and point at the control that actually stops it.
  const blockers = await archiveBlockers(db, borrowerId);
  if (blockers.activeSchedule || blockers.liveMandate) {
    const what = blockers.activeSchedule && blockers.liveMandate
      ? "an active schedule and a live bank mandate"
      : blockers.activeSchedule
        ? "an active schedule"
        : "a live bank mandate";
    return {
      message:
        `${borrower.legal_name} still has ${what}, so archiving would hide them while their money kept being collected. ` +
        `Use "Pause collections" first, which actually stops it.`,
      tone: "error",
    };
  }

  await archiveBorrower(db, borrowerId);
  await writeAudit(db, {
    actorStaffId: user.id,
    action: "borrower.archive",
    entityType: "borrower",
    entityId: borrowerId,
    metadata: { legalName: borrower.legal_name },
  });

  revalidatePath("/borrowers");
  revalidatePath("/borrowers/archived");
  return { message: `${borrower.legal_name} archived. Their records are kept.`, tone: "success" };
}

/** Bring an archived borrower back, so archiving is never a one-way door. */
export async function restoreBorrowerAction(
  _prev: ArchiveState,
  fd: FormData,
): Promise<ArchiveState> {
  const user = await requireRole("operator");
  const db = getDb();
  const borrowerId = String(fd.get("borrowerId") ?? "");
  if (!borrowerId) return { message: "Something went wrong: no borrower was selected.", tone: "error" };

  const borrower = await getBorrowerIncludingArchived(db, borrowerId);
  if (!borrower) return { message: "That borrower no longer exists.", tone: "error" };

  await restoreBorrower(db, borrowerId);
  await writeAudit(db, {
    actorStaffId: user.id,
    action: "borrower.restore",
    entityType: "borrower",
    entityId: borrowerId,
    metadata: { legalName: borrower.legal_name },
  });

  revalidatePath("/borrowers");
  revalidatePath("/borrowers/archived");
  return { message: `${borrower.legal_name} restored.`, tone: "success" };
}
