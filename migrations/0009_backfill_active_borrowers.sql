-- Borrowers who are being collected from but still read "Onboarding".
--
-- borrowers.status was only flipped to 'active' in two of the three places a
-- mandate becomes authorised: the Plaid Link callback and the Plaid webhook. The
-- third, the setup page's own recheck against Plaid, was added precisely BECAUSE
-- the callback is lost so often on a phone (the bank opens in its own tab and
-- the tab that was waiting is gone), and it recorded the authorised mandate
-- without ever touching the borrower. Those borrowers hold a live mandate and
-- are collected from every cycle, because collectPayment skips only paused,
-- revoked and expired -- and yet the list still shows them as onboarding, which
-- is the one screen staff use to see who has finished.
--
-- The code paths are fixed; this repairs the rows they already left behind.
--
-- Deliberately narrow:
--   * only 'onboarding' rows move. A paused borrower stays paused, because pause
--     is an operator's decision to stop collecting and no migration may undo it.
--     Revoked and expired rows are left for the maintenance sweep, which asks the
--     bank rather than guessing from what we happen to hold.
--   * a live mandate must actually exist, so this can never mark a borrower
--     collectable that no bank has approved. It reads the same condition the
--     application now enforces.
--   * archived borrowers are included on purpose: archiving hides a borrower, it
--     does not stop collections, so their status must still be honest.
UPDATE borrowers
   SET status = 'active'
 WHERE status = 'onboarding'
   AND EXISTS (
     SELECT 1 FROM consents c
      WHERE c.borrower_id = borrowers.id AND c.status = 'authorized'
   );
