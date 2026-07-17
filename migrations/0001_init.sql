-- Excel Capital VRP platform — initial schema (Cloudflare D1 / SQLite).
-- Money is stored as INTEGER minor units (pence) + a currency code. Never floats.
-- Ids are UUID text. Timestamps are ISO-8601 text (UTC).

-- Internal staff. Cloudflare Access authenticates the human; this table holds role.
CREATE TABLE staff_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

-- Incorporated business borrowers.
CREATE TABLE borrowers (
  id            TEXT PRIMARY KEY,
  legal_name    TEXT NOT NULL,
  company_number TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'onboarding'
                  CHECK (status IN ('onboarding','active','paused','revoked','expired')),
  deleted_at    TEXT,                       -- soft delete
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by    TEXT REFERENCES staff_users(id)
);
CREATE INDEX idx_borrowers_status ON borrowers(status);
CREATE INDEX idx_borrowers_company ON borrowers(company_number);

-- Who receives the money (configured per borrower during onboarding).
CREATE TABLE recipients (
  id                TEXT PRIMARY KEY,
  borrower_id       TEXT NOT NULL REFERENCES borrowers(id),
  plaid_recipient_id TEXT,
  name              TEXT NOT NULL,
  account_number    TEXT,
  sort_code         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_recipients_borrower ON recipients(borrower_id);

-- VRP consent (the reusable mandate). plaid_consent_id stored encrypted at app layer.
CREATE TABLE consents (
  id                       TEXT PRIMARY KEY,
  borrower_id              TEXT NOT NULL REFERENCES borrowers(id),
  plaid_consent_id         TEXT,           -- encrypted ciphertext
  plaid_recipient_id       TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','authorized','revoked','expired','rejected')),
  currency                 TEXT NOT NULL DEFAULT 'GBP',
  max_payment_amount_minor INTEGER,
  period                   TEXT,           -- e.g. 'DAY','WEEK','MONTH'
  periodic_alignment       TEXT,           -- e.g. 'CALENDAR','CONSENT'
  periodic_max_amount_minor INTEGER,
  valid_from               TEXT,
  valid_to                 TEXT,
  authorized_at            TEXT,
  raw_constraints          TEXT,           -- JSON blob of the full Plaid constraints
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_consents_borrower ON consents(borrower_id);
CREATE INDEX idx_consents_status ON consents(status);

-- Repayment schedule. Supports weekly/fortnightly/monthly/custom and 3 end modes.
CREATE TABLE repayment_schedules (
  id             TEXT PRIMARY KEY,
  borrower_id    TEXT NOT NULL REFERENCES borrowers(id),
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'GBP',
  frequency      TEXT NOT NULL CHECK (frequency IN ('weekly','fortnightly','monthly','custom')),
  interval_days  INTEGER,                  -- for 'custom'
  start_date     TEXT NOT NULL,
  end_mode       TEXT NOT NULL CHECK (end_mode IN ('date','count','total')),
  end_date       TEXT,
  end_count      INTEGER,
  end_total_minor INTEGER,
  next_run_date  TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sched_borrower ON repayment_schedules(borrower_id);
CREATE INDEX idx_sched_next_run ON repayment_schedules(next_run_date) WHERE active = 1;

-- Payment attempts. UNIQUE(idempotency_key) is the DB-level double-collection guard.
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  borrower_id     TEXT NOT NULL REFERENCES borrowers(id),
  consent_id      TEXT REFERENCES consents(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  plaid_payment_id TEXT,
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','submitted','initiated','executed',
                                      'settled','failed','rejected','cancelled')),
  scheduled_for   TEXT,
  submitted_at    TEXT,
  last_status_at  TEXT,
  failure_reason  TEXT,
  retry_of        TEXT REFERENCES payments(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_payments_borrower ON payments(borrower_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_plaid ON payments(plaid_payment_id);

-- Signed, single-use, expiring borrower setup URLs. Only the hash is stored.
CREATE TABLE setup_links (
  id          TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL REFERENCES borrowers(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT REFERENCES staff_users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_setup_links_borrower ON setup_links(borrower_id);

-- Raw Plaid webhook events, deduped by provider event id.
CREATE TABLE webhook_events (
  id                 TEXT PRIMARY KEY,      -- provider event id (dedupe key)
  plaid_webhook_type TEXT,
  plaid_payment_id   TEXT,
  payload            TEXT NOT NULL,         -- JSON
  signature_verified INTEGER NOT NULL DEFAULT 0,
  received_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at       TEXT
);
CREATE INDEX idx_webhook_payment ON webhook_events(plaid_payment_id);

-- Global settings (single row, id = 'singleton').
CREATE TABLE settings (
  id                        TEXT PRIMARY KEY DEFAULT 'singleton',
  default_retry_max         INTEGER NOT NULL DEFAULT 3,
  default_retry_spacing_hours INTEGER NOT NULL DEFAULT 24,
  default_reference_format  TEXT NOT NULL DEFAULT 'EXCEL-{borrower}-{seq}',
  sending_domain            TEXT,
  retention_days            INTEGER NOT NULL DEFAULT 2190, -- ~6 years, owner to confirm
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by                TEXT REFERENCES staff_users(id)
);
INSERT INTO settings (id) VALUES ('singleton');

-- Immutable audit trail of important actions.
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  actor_staff_id TEXT REFERENCES staff_users(id),
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  metadata     TEXT,                        -- JSON
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
