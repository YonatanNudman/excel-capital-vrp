-- Add a soft-disable flag to staff. A non-null disabled_at means the account
-- is deactivated: it cannot authenticate and is excluded from active-admin counts.
ALTER TABLE staff_users ADD COLUMN disabled_at TEXT;
