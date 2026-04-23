import 'dotenv/config';

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'appuser',
    password: process.env.MYSQL_PASSWORD || 'apppass',
    database: process.env.MYSQL_DATABASE || 'amazon_monitor',
  },
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  selectorVersion: parseInt(process.env.SELECTOR_VERSION || '1', 10),

  coordinator: {
    tickIntervalMs: 1000,
    maxJobsPerClient: 3,
    jobTimeoutSec: 300,
    maxRetriesPerJob: 3,
  },

  fairness: {
    recalcIntervalMs: 5 * 60 * 1000,
    maxHourlyMultiplier: 1.5,
    nightHoursStart: 0,
    nightHoursEnd: 7,
    nightMaxMultiplier: 3.0,
  },

  tiers: {
    hot:    { intervalSec: 600,   minWatchers: 100, volatilityThreshold: 0.05 },
    warm:   { intervalSec: 3600,  minWatchers: 10 },
    cold:   { intervalSec: 21600, minWatchers: 1 },
    frozen: { intervalSec: 86400 },
  },

  notification: {
    discordRateLimit: 5,
    discordRateWindowMs: 2000,
    cooldownDefaultSec: 3600,
    maxRetriesPerNotification: 3,
  },
};
