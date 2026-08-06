-- Let a person who is not yet staff ask for access, and let an admin approve or
-- deny them, instead of the app simply refusing with "Not authorised".
--
-- One row per email. status starts 'pending'; an admin moves it to 'approved'
-- (which also creates the staff_users row) or 'denied'. A denied row is kept
-- deliberately: it is what stops the same address requesting again and again.
--
-- Plain CREATE TABLE, no rebuild of anything existing.

CREATE TABLE access_requests (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','denied')),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at   TEXT,
  decided_by   TEXT REFERENCES staff_users(id),
  granted_role TEXT CHECK (granted_role IN ('admin','operator','viewer'))
);

CREATE INDEX idx_access_requests_status ON access_requests(status, requested_at);
