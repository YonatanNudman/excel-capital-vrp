-- Rebuild the payment ledger with explicit uncertainty and reconciliation data.
-- Existing rows are preserved; new columns are nullable/defaulted for compatibility.
ALTER TABLE payments RENAME TO payments_legacy;

CREATE TABLE payments (
  id                      TEXT PRIMARY KEY,
  borrower_id             TEXT NOT NULL REFERENCES borrowers(id),
  consent_id              TEXT REFERENCES consents(id),
  schedule_id             TEXT REFERENCES repayment_schedules(id),
  idempotency_key         TEXT NOT NULL UNIQUE,
  plaid_payment_id        TEXT,
  provider_request_id     TEXT,
  amount_minor            INTEGER NOT NULL CHECK (amount_minor > 0),
  currency                TEXT NOT NULL DEFAULT 'GBP' CHECK (length(currency) = 3),
  reference               TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','unknown','submitted','initiated',
                                              'executed','settled','failed','rejected','cancelled')),
  status_version          INTEGER NOT NULL DEFAULT 0,
  scheduled_for           TEXT,
  submitted_at            TEXT,
  last_status_at          TEXT,
  last_provider_check_at  TEXT,
  reconcile_after         TEXT,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  failure_reason          TEXT,
  retry_of                TEXT REFERENCES payments(id),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO payments (
  id, borrower_id, consent_id, idempotency_key, plaid_payment_id,
  amount_minor, currency, reference, status, scheduled_for, submitted_at,
  last_status_at, failure_reason, retry_of, created_at
)
SELECT
  id, borrower_id, consent_id, idempotency_key, plaid_payment_id,
  amount_minor, currency, reference, status, scheduled_for, submitted_at,
  last_status_at, failure_reason, retry_of, created_at
FROM payments_legacy;

DROP TABLE payments_legacy;

CREATE INDEX idx_payments_borrower ON payments(borrower_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE UNIQUE INDEX idx_payments_plaid_unique
  ON payments(plaid_payment_id) WHERE plaid_payment_id IS NOT NULL;
CREATE INDEX idx_payments_schedule ON payments(schedule_id);
CREATE INDEX idx_payments_reconcile
  ON payments(reconcile_after) WHERE reconcile_after IS NOT NULL;

-- Durable business intents make browser resubmission and provider execution refer
-- to one stable operation rather than to a transient HTTP request.
CREATE TABLE payment_intents (
  id              TEXT PRIMARY KEY,
  borrower_id     TEXT NOT NULL REFERENCES borrowers(id),
  schedule_id     TEXT REFERENCES repayment_schedules(id),
  kind            TEXT NOT NULL CHECK (kind IN ('manual','scheduled','retry')),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL CHECK (length(currency) = 3),
  reference       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'prepared'
                    CHECK (status IN ('prepared','executing','completed','cancelled')),
  payment_id      TEXT UNIQUE REFERENCES payments(id),
  created_by      TEXT REFERENCES staff_users(id),
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_intents_borrower ON payment_intents(borrower_id, created_at);

-- A deterministic hash permits consent webhook lookup without storing the
-- provider consent identifier in plaintext.
ALTER TABLE consents ADD COLUMN plaid_consent_id_hash TEXT;
CREATE UNIQUE INDEX idx_consents_plaid_hash
  ON consents(plaid_consent_id_hash) WHERE plaid_consent_id_hash IS NOT NULL;
