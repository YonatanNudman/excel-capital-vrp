"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { updateSettings } from "@/lib/repo/settings";
import { writeAudit } from "@/lib/repo/audit";

export async function updateSettingsAction(fd: FormData): Promise<void> {
  const user = await requireRole("admin");
  const db = getDb();

  const numOrUndef = (k: string) => {
    const v = fd.get(k);
    if (typeof v !== "string" || !v.trim()) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const strOrUndef = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  await updateSettings(
    db,
    {
      defaultRetryMax: numOrUndef("defaultRetryMax"),
      defaultRetrySpacingHours: numOrUndef("defaultRetrySpacingHours"),
      defaultReferenceFormat: strOrUndef("defaultReferenceFormat"),
      sendingDomain: strOrUndef("sendingDomain") ?? null,
      retentionDays: numOrUndef("retentionDays"),
    },
    user.id,
  );
  await writeAudit(db, {
    actorStaffId: user.id,
    action: "settings.update",
    entityType: "settings",
    entityId: "singleton",
  });
  revalidatePath("/settings");
}
