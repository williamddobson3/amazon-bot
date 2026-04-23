import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import config from './config.js';
import log from './utils/logger.js';
import { migrate } from './db/mysql.js';
import apiRouter from './api/router.js';
import { startWebSocketServer } from './ws/hub.js';
import { startCoordinator } from './services/coordinator.js';

// Last-resort crash prevention: if a route handler forgets to await or
// throws inside a Promise chain we haven't wrapped, log it loudly but
// don't kill the process. This is a one-extension-per-user service; a
// single bad request should never take down scraping for everyone.
process.on('unhandledRejection', (reason) => {
  log.error(`UNHANDLED REJECTION: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`UNCAUGHT EXCEPTION: ${err?.stack || err}`);
});

async function main() {
  await migrate();

  const app = express();

  // Allow requests from the Chrome extension (chrome-extension://...) and
  // any web origin. The extension's Origin header in fetch requests is
  // chrome-extension://<id>, which cors() accepts by default.
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // Global Express error middleware. Express 4 doesn't auto-catch errors
  // thrown inside async route handlers, so any missed try/catch would
  // propagate as an unhandled rejection and crash the process. This
  // converts them into a clean 500 JSON response instead.
  app.use((err, req, res, _next) => {
    log.error(`Express error on ${req.method} ${req.path}: ${err?.stack || err}`);
    if (res.headersSent) return;
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: err?.message || 'Unknown error',
    });
  });

  const httpServer = createServer(app);

  startWebSocketServer(httpServer);

  startCoordinator();

  // Bind to 0.0.0.0 so the VPS accepts connections from remote clients
  // (the Chrome extension running on the user's local PC).
  httpServer.listen(config.port, '0.0.0.0', () => {
    log.info(`HTTP + WebSocket server listening on 0.0.0.0:${config.port}`);
  });
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  import('fs').then(({ writeFileSync }) => {
    writeFileSync('startup-error.txt', `${err.stack || err.message}\n`);
  });
  setTimeout(() => process.exit(1), 200);
});
