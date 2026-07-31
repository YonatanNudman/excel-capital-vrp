-- Store the registered office pulled from Companies House, so staff can see
-- where a borrower is actually registered without leaving the app.
--
-- Two plain ADD COLUMNs: no rebuild, and nothing references borrowers in a way
-- a rebuild could damage. See migrations/0004 for why rebuilds are avoided here.
--
-- The address is kept as one formatted display line (postal order) plus the
-- postcode on its own, which is the part most often needed separately.

ALTER TABLE borrowers ADD COLUMN registered_address TEXT;
ALTER TABLE borrowers ADD COLUMN registered_postcode TEXT;
