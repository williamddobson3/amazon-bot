-- 003_bulk_batches.sql
--
-- Bulk ingest support. A single bulk POST creates one row in scrape_batches
-- and stamps every newly-inserted watchlists row with that batch_id. The
-- side panel polls the batch row for a progress bar, and each terminal
-- scrape result (success or failure) increments the batch counter exactly
-- once via watchlists.batch_done.

-- Intentionally NO foreign key on user_id.
--
-- A stale JWT (e.g. after wiping the database and redeploying) would
-- otherwise crash the bulk endpoint with a FK violation the first time
-- it tries to create a batch. Batches are ephemeral per-request progress
-- rows, not long-lived relational data, so app-level validation is
-- sufficient. Migration 004 drops the FK on existing deployments that
-- already ran the earlier version of this file.
CREATE TABLE IF NOT EXISTS scrape_batches (
  id           CHAR(36)   NOT NULL PRIMARY KEY,
  user_id      CHAR(36)   NOT NULL,
  total        INT        NOT NULL,
  completed    INT        NOT NULL DEFAULT 0,
  failed       INT        NOT NULL DEFAULT 0,
  status       ENUM('running','done','cancelled') NOT NULL DEFAULT 'running',
  started_at   DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  DATETIME   NULL,
  INDEX idx_scrape_batches_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE watchlists ADD COLUMN batch_id   CHAR(36)   NULL;
ALTER TABLE watchlists ADD COLUMN batch_done TINYINT(1) NOT NULL DEFAULT 1;

CREATE INDEX idx_watchlists_batch ON watchlists(batch_id);
