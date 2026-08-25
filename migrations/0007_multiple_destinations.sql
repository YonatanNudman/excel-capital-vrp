-- Multiple payout destinations per borrower ("Option B").
--
-- Proven against the Plaid UK sandbox before building this: one borrower, one
-- bank login, TWO recipients and TWO consents can be authorised at the same
-- time, and each consent pays into its own recipient. Verified by executing £1
-- against each mandate and reading back the destination on the resulting
-- payments (main -> acct 12345678, backup -> acct 87654321).
--
-- That result is why this migration exists and why the model is shaped this way:
-- you do NOT choose a destination at execution time. Plaid's
-- consent/payment/execute takes only a consent_id and an amount, with no
-- recipient, so money can never be rerouted after the borrower has approved it.
-- You choose the destination by choosing WHICH MANDATE to collect against.
-- Each mandate is permanently welded to one account, which is the property that
-- makes this safe rather than a loophole.
--
-- Deliberately additive only: ALTER TABLE ... ADD COLUMN, no table rebuild.
-- Migration 0004 learned this the hard way. Renaming a table makes SQLite
-- rewrite the FK clauses in every table that references it, which silently
-- repointed payments/payment_intents at a temp table and cost a rollback.
-- Nothing here renames anything, so no FK text is touched.

-- 1. Recipients become a list, so each one needs a human label and one of them
--    needs to be the default. Existing rows have no label; the UI falls back to
--    the account name, which is what staff already recognise.
ALTER TABLE recipients ADD COLUMN label TEXT;
ALTER TABLE recipients ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
-- Archived rather than deleted: a payment's history points at a consent which
-- points here, so a destination must remain readable forever even once it is
-- retired from the picker.
ALTER TABLE recipients ADD COLUMN archived_at TEXT;

-- 2. The consent/recipient pairing, previously implied. plaid_recipient_id
--    already recorded WHICH Plaid recipient a consent was created against, but
--    as an opaque provider string with no FK, so it could not be joined on.
ALTER TABLE consents ADD COLUMN recipient_id TEXT REFERENCES recipients(id);

-- 3. Where scheduled collections go. NULL means "the borrower's default
--    destination", which keeps every pre-existing schedule behaving exactly as
--    it did before this migration.
ALTER TABLE repayment_schedules ADD COLUMN consent_id TEXT REFERENCES consents(id);

-- 4. Backfill, reproducing the OLD single-destination semantics exactly.
--    getRecipient() was "ORDER BY created_at DESC LIMIT 1", so that same row
--    becomes the default and nothing changes for existing borrowers.
UPDATE recipients SET is_default = 1
 WHERE id IN (
   SELECT r.id FROM recipients r
    WHERE r.created_at = (
      SELECT MAX(r2.created_at) FROM recipients r2 WHERE r2.borrower_id = r.borrower_id
    )
   GROUP BY r.borrower_id
 );

UPDATE consents SET recipient_id = (
  SELECT r.id FROM recipients r
   WHERE r.borrower_id = consents.borrower_id
   ORDER BY r.is_default DESC, r.created_at DESC LIMIT 1
) WHERE recipient_id IS NULL;

-- 5. At most one default per borrower, enforced by the database rather than by
--    remembering to clear the old one. A partial unique index is the only way
--    to say this in SQLite; setDefault must therefore clear and set inside one
--    transaction (D1 batch), which it does.
CREATE UNIQUE INDEX idx_recipients_one_default
  ON recipients(borrower_id) WHERE is_default = 1;

CREATE INDEX idx_consents_recipient ON consents(recipient_id);
CREATE INDEX idx_recipients_active
  ON recipients(borrower_id) WHERE archived_at IS NULL;
