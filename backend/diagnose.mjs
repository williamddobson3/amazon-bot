import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import 'dotenv/config';

console.log('=== DIAGNOSTICS ===\n');

// ── MySQL ──────────────────────────────────────────────────
console.log('Testing MySQL...');
console.log('  Host    :', process.env.MYSQL_HOST || 'localhost');
console.log('  Port    :', process.env.MYSQL_PORT || 3306);
console.log('  User    :', process.env.MYSQL_USER || 'appuser');
console.log('  Password:', process.env.MYSQL_PASSWORD ? '(set)' : '(empty)');
console.log('  Database:', process.env.MYSQL_DATABASE || 'amazon_monitor');

try {
  const conn = await mysql.createConnection({
    host:     process.env.MYSQL_HOST     || 'localhost',
    port:     parseInt(process.env.MYSQL_PORT || '3306'),
    user:     process.env.MYSQL_USER     || 'appuser',
    password: process.env.MYSQL_PASSWORD || 'appuser',
    database: process.env.MYSQL_DATABASE || 'amazon_monitor',
  });
  await conn.query('SELECT 1');
  console.log('  ✅ MySQL OK\n');
  await conn.end();
} catch (err) {
  console.error('  ❌ MySQL FAILED:', err.message, '\n');
}

// ── Redis ──────────────────────────────────────────────────
console.log('Testing Redis...');
console.log('  URL:', process.env.REDIS_URL || 'redis://localhost:6379');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
});
try {
  await redis.connect();
  const pong = await redis.ping();
  console.log('  ✅ Redis OK —', pong, '\n');
} catch (err) {
  console.error('  ❌ Redis FAILED:', err.message, '\n');
}
redis.disconnect();

console.log('=== DONE ===');
process.exit(0);
