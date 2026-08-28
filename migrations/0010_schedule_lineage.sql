-- Give a repayment schedule an identity that survives being edited.
--
-- Editing a schedule does not update the row; it deactivates it and inserts a
-- new one with a NEW id (upsertSchedule), so that the superseded version stays
-- readable. Everything that answers "how far through this loan are we" is keyed
-- on that id: collectionProgress counts payments by schedule_id, the end
-- conditions (after N payments / until a total) read those counts, and the
-- double-collection guard hashes the schedule id into the idempotency key.
--
-- So an edit silently reset the loan to zero. paymentsMade and collectedMinor
-- both read 0 against the new row, a schedule that had already taken 34 of its
-- 40 payments would run its full term again, and the deterministic key that is
-- supposed to make a repeat collection for one due date impossible produced a
-- different key either side of the edit, so the UNIQUE(idempotency_key) guard
-- could not see the earlier payment.
--
-- lineage_id is the id of the FIRST schedule in the chain. Every later version
-- carries it forward, so progress, end conditions and idempotency keys follow
-- the loan rather than the row.
--
-- Backfilled to the row's own id, which is exactly what a never-edited schedule
-- means, and which keeps every existing idempotency key byte-identical: keys for
-- schedules already in flight must not change, or tonight's sweep would not
-- recognise a payment it already made this morning.
ALTER TABLE repayment_schedules ADD COLUMN lineage_id TEXT;

UPDATE repayment_schedules SET lineage_id = id WHERE lineage_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_schedules_lineage ON repayment_schedules(lineage_id);
