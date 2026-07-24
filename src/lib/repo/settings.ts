import type { Settings } from "@/lib/types";

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare("SELECT * FROM settings WHERE id = 'singleton'")
    .first<Settings>();
  if (!row) throw new Error("settings singleton missing (migration not applied?)");
  return row;
}

export async function updateSettings(
  db: D1Database,
  data: Partial<{
    defaultRetryMax: number;
    defaultRetrySpacingHours: number;
    defaultReferenceFormat: string;
    sendingDomain: string | null;
    retentionDays: number;
  }>,
  updatedBy: string | null,
): Promise<void> {
  if (data.defaultRetryMax !== undefined &&
      (!Number.isInteger(data.defaultRetryMax) || data.defaultRetryMax < 0 || data.defaultRetryMax > 10)) {
    throw new Error("retry maximum must be an integer between 0 and 10");
  }
  if (data.defaultRetrySpacingHours !== undefined &&
      (!Number.isFinite(data.defaultRetrySpacingHours) || data.defaultRetrySpacingHours < 1 || data.defaultRetrySpacingHours > 720)) {
    throw new Error("retry spacing must be between 1 and 720 hours");
  }
  if (data.retentionDays !== undefined &&
      (!Number.isInteger(data.retentionDays) || data.retentionDays < 1 || data.retentionDays > 3650)) {
    throw new Error("retention must be between 1 and 3650 days");
  }
  if (data.defaultReferenceFormat !== undefined &&
      (data.defaultReferenceFormat.length > 100 || !/[A-Za-z0-9{]/.test(data.defaultReferenceFormat))) {
    throw new Error("invalid payment reference format");
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (data.defaultRetryMax !== undefined) {
    sets.push("default_retry_max = ?");
    binds.push(data.defaultRetryMax);
  }
  if (data.defaultRetrySpacingHours !== undefined) {
    sets.push("default_retry_spacing_hours = ?");
    binds.push(data.defaultRetrySpacingHours);
  }
  if (data.defaultReferenceFormat !== undefined) {
    sets.push("default_reference_format = ?");
    binds.push(data.defaultReferenceFormat);
  }
  if (data.sendingDomain !== undefined) {
    sets.push("sending_domain = ?");
    binds.push(data.sendingDomain);
  }
  if (data.retentionDays !== undefined) {
    sets.push("retention_days = ?");
    binds.push(data.retentionDays);
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  sets.push("updated_by = ?");
  binds.push(updatedBy);
  binds.push("singleton");
  await db
    .prepare(`UPDATE settings SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}
