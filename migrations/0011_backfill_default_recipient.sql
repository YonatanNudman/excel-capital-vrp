-- Give every borrower a default payout account.
--
-- Migration 0007 introduced recipients.is_default and backfilled the borrowers
-- that existed then. The borrower-creation path was never updated to match: its
-- INSERT omits the column, so every borrower onboarded through the UI since has
-- had NO default account at all.
--
-- That is not cosmetic. The guards protecting the account money actually lands
-- in are written in terms of the default: "this is the default account, make
-- another one the default first" is what stops an operator retiring the account
-- their borrower's repayments are collected into, and with no row marked it
-- could never fire. The destinations panel also showed no account as the one in
-- use, so nothing on screen said where the money was going either.
--
-- The oldest live account is the right choice: addRecipient makes a borrower's
-- FIRST account their default, so this is the same rule applied retrospectively.
-- Archived accounts are excluded, and the partial unique index (one default per
-- borrower) is respected because this only touches borrowers that have none.
UPDATE recipients
   SET is_default = 1
 WHERE id IN (
   SELECT r.id
     FROM recipients r
    WHERE r.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM recipients d
         WHERE d.borrower_id = r.borrower_id AND d.is_default = 1
      )
      AND r.created_at = (
        SELECT MIN(r2.created_at) FROM recipients r2
         WHERE r2.borrower_id = r.borrower_id AND r2.archived_at IS NULL
      )
    GROUP BY r.borrower_id
 );
