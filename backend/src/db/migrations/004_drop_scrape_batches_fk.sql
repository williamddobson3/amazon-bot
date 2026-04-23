-- 004_drop_scrape_batches_fk.sql
--
-- For deployments that already ran the earlier version of migration 003
-- which created scrape_batches with a FOREIGN KEY on user_id, drop that
-- FK now. A stale JWT (e.g. after a DB wipe) would otherwise crash the
-- bulk endpoint with ER_NO_REFERENCED_ROW_2 the first time it tries to
-- insert a batch row.
--
-- The migration runner swallows ER_CANT_DROP_FIELD_OR_KEY so this is a
-- no-op on fresh installs that never had the FK.

ALTER TABLE scrape_batches DROP FOREIGN KEY scrape_batches_ibfk_1;
