CREATE DATABASE IF NOT EXISTS amazon_monitor
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'appuser'@'localhost' IDENTIFIED BY 'appuser';

GRANT ALL PRIVILEGES ON amazon_monitor.* TO 'appuser'@'localhost';

FLUSH PRIVILEGES;