-- 002_per_user_observations.sql
--
-- Architectural change: move from "shared scrape data across users" to
-- "each user owns their own observations." This is required because Amazon
-- personalizes prices per session (postal code, Prime status, A/B bucket),
-- so one user's scrape result is not a valid observation for another user.
--
-- Changes:
--   1. Per-user scrape state moves from asin_master into watchlists
--      (next_scrape_at, last_price, last_*, scrape_failures, etc.)
--   2. observations.scraper_user_id becomes NOT NULL and is treated as
--      the authoritative owner of each row
--   3. New (user_id, asin, observed_at) index for per-user chart queries
--   4. Per-user priority enum on watchlists replaces the shared tier system

-- ── 1. Per-user state on watchlists ───────────────────────────
ALTER TABLE watchlists
  ADD COLUMN priority ENUM('starred','normal','archived') NOT NULL DEFAULT 'normal',
  ADD COLUMN interval_sec INT NOT NULL DEFAULT 21600,
  ADD COLUMN next_scrape_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN last_scraped_at DATETIME NULL,
  ADD COLUMN last_price INT NULL,
  ADD COLUMN last_points INT NULL,
  ADD COLUMN last_marketplace_lowest INT NULL,
  ADD COLUMN last_new_offer_count INT NULL,
  ADD COLUMN last_delivery_time TEXT NULL,
  ADD COLUMN last_error VARCHAR(100) NULL,
  ADD COLUMN last_error_at DATETIME NULL,
  ADD COLUMN scrape_failures INT NOT NULL DEFAULT 0;

CREATE INDEX idx_watchlists_next_scrape ON watchlists(next_scrape_at);
CREATE INDEX idx_watchlists_priority    ON watchlists(user_id, priority);

-- ── 2. Per-user observations ──────────────────────────────────
-- Backfill any existing NULL scraper_user_id rows by joining via watchers.
-- For now, just delete orphaned rows since the data model has changed.
DELETE FROM observations WHERE scraper_user_id IS NULL;

ALTER TABLE observations
  MODIFY scraper_user_id CHAR(36) NOT NULL;

CREATE INDEX idx_observations_user_asin_time
  ON observations(scraper_user_id, asin, observed_at);
