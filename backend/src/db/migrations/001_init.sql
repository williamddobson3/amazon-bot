-- Users
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  plan VARCHAR(20) NOT NULL DEFAULT 'free',
  contribution_rank CHAR(1) NOT NULL DEFAULT 'B',
  trust_score INT NOT NULL DEFAULT 50,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ASIN master (shared across all users)
CREATE TABLE IF NOT EXISTS asin_master (
  asin CHAR(10) NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  watcher_count INT NOT NULL DEFAULT 0,
  tier VARCHAR(10) NOT NULL DEFAULT 'cold',
  interval_sec INT NOT NULL DEFAULT 21600,
  last_scraped_at DATETIME NULL,
  next_scrape_at DATETIME NULL,
  last_price INT NULL,
  last_points INT NULL,
  last_marketplace_lowest INT NULL,
  last_new_offer_count INT NULL,
  last_delivery_time TEXT NULL,
  last_error VARCHAR(100) NULL,
  scrape_failures INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_asin_master_next_scrape ON asin_master(next_scrape_at);
CREATE INDEX idx_asin_master_tier ON asin_master(tier);

-- Watchlists (user <-> ASIN mapping)
CREATE TABLE IF NOT EXISTS watchlists (
  user_id CHAR(36) NOT NULL,
  asin CHAR(10) NOT NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, asin),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (asin) REFERENCES asin_master(asin) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_watchlists_asin ON watchlists(asin);
CREATE INDEX idx_watchlists_user ON watchlists(user_id);

-- Observations (price time-series)
CREATE TABLE IF NOT EXISTS observations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  asin CHAR(10) NOT NULL,
  observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  price INT NULL,
  points INT NULL,
  delivery_time TEXT NULL,
  marketplace_lowest INT NULL,
  new_offer_count INT NULL,
  scraper_user_id CHAR(36) NULL,
  PRIMARY KEY (id),
  INDEX idx_observations_asin_time (asin, observed_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Observations daily aggregation
CREATE TABLE IF NOT EXISTS observations_daily (
  asin CHAR(10) NOT NULL,
  day DATE NOT NULL,
  avg_price DECIMAL(10,2) NULL,
  min_price INT NULL,
  max_price INT NULL,
  avg_offers DECIMAL(10,2) NULL,
  sample_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (asin, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User conditions
CREATE TABLE IF NOT EXISTS conditions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  asin CHAR(10) NULL,
  rule_type VARCHAR(50) NOT NULL,
  rule_params JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  cooldown_sec INT NOT NULL DEFAULT 3600,
  last_fired_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_conditions_user (user_id),
  INDEX idx_conditions_asin (asin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Discord webhooks
CREATE TABLE IF NOT EXISTS discord_webhooks (
  user_id CHAR(36) NOT NULL PRIMARY KEY,
  webhook_url TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notification log
CREATE TABLE IF NOT EXISTS notification_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  asin CHAR(10) NOT NULL,
  condition_id BIGINT NULL,
  price_at_trigger INT NULL,
  moving_avg INT NULL,
  discord_status INT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (condition_id) REFERENCES conditions(id) ON DELETE SET NULL,
  INDEX idx_notification_log_user (user_id, sent_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ASIN watchers rotation
CREATE TABLE IF NOT EXISTS asin_watchers (
  asin CHAR(10) NOT NULL,
  user_id CHAR(36) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (asin, user_id),
  FOREIGN KEY (asin) REFERENCES asin_master(asin) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_asin_watchers_asin_pos (asin, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Selector definitions (served to extensions)
CREATE TABLE IF NOT EXISTS selector_config (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  version INT NOT NULL,
  selectors JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
