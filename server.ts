/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import apiRouter from './server/routes/api.js';
import { getLeadsDb } from './server/db.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const scriptSourcePolicy = isProduction ? "'self'" : "'self' 'unsafe-inline'";

// This is a single-user, local desktop service. Keep it loopback-only and avoid
// accepting arbitrarily large bodies before an API handler has a chance to validate them.
app.disable('x-powered-by');
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src ${scriptSourcePolicy}; base-uri 'self'; frame-ancestors 'none'`
  );
  next();
});
app.use(express.json({ limit: '1mb' }));

// DNS-Rebinding Guard
// Validates Host and Origin headers on every API request. Even though the server is
// bound to 127.0.0.1, a malicious page open in the user's browser can still reach
// localhost via same-machine loopback unless we explicitly reject non-loopback Host values.
app.use('/api', (req: express.Request, res: express.Response, next: express.NextFunction): any => {
  const rawHost = (req.headers.host || '').toLowerCase();
  const colonIdx = rawHost.lastIndexOf(':');
  const hostname = colonIdx !== -1 ? rawHost.slice(0, colonIdx) : rawHost;
  const portStr = colonIdx !== -1 ? rawHost.slice(colonIdx + 1) : '';
  const port = portStr ? Number(portStr) : 80;

  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isCorrectPort = !portStr || port === PORT;

  if (!isLoopbackHost || !isCorrectPort) {
    return res.status(400).type('text/plain').send('Invalid Host header. Direct API access from non-loopback origins is blocked.');
  }

  const originHeader = req.headers.origin;
  if (originHeader) {
    let originOk = false;
    try {
      const originUrl = new URL(originHeader);
      const oHost = originUrl.hostname.toLowerCase();
      const oPort = originUrl.port ? Number(originUrl.port) : (originUrl.protocol === 'https:' ? 443 : 80);
      originOk = (oHost === 'localhost' || oHost === '127.0.0.1') && oPort === PORT;
    } catch {
      // Malformed Origin header - reject.
    }
    if (!originOk) {
      return res.status(400).type('text/plain').send('Cross-origin API access is blocked.');
    }
  }

  next();
});

// Mount the API router
app.use('/api', apiRouter);
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  if (typeof error === 'object' && error && 'type' in error && (error as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body exceeds the 1 MB limit.' });
  }
  return next(error);
});

// -----------------------------------------------------------------------------
// Dev & Build Routing Setup
// -----------------------------------------------------------------------------

async function startServer() {
  // Eagerly warm up the database during startup
  try {
    getLeadsDb();
    console.log('Database initialized and warmed up.');
  } catch (error) {
    console.error('Failed to eagerly initialize database:', error);
    process.exitCode = 1;
    return;
  }

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use((req, res, next) => {
      if (/\.(?:cjs|map)$/i.test(req.path)) return res.sendStatus(404);
      return next();
    });
    app.use(express.static(distPath, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-store');
        }
      }
    }));
    // Express 5 uses path-to-regexp v8, where a catch-all must be named.
    app.get('/{*splat}', (req, res) => {
      if (path.extname(req.path)) return res.sendStatus(404);
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Server launched at http://${HOST}:${PORT} in ${isProduction ? 'production' : 'development'} mode.`);
  });

  server.on('error', (error) => {
    console.error(`Unable to start Apex CRM on ${HOST}:${PORT}:`, error);
    process.exitCode = 1;
  });

  const shutdown = (signal: string) => {
    console.log(`\n[${signal}] Shutting down Apex CRM server gracefully...`);
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    // Mark any active mining sessions as interrupted so the DB is consistent.
    try {
      getLeadsDb().exec(`
        UPDATE mining_sessions
        SET status        = 'interrupted',
            error_message = COALESCE(error_message, 'Server process exited (${signal}).'),
            completed_at  = COALESCE(completed_at, datetime('now')),
            updated_at    = datetime('now')
        WHERE status IN ('running', 'cancellation_requested')
      `);
    } catch (dbErr) {
      console.warn('Could not update interrupted mining sessions:', dbErr);
    }
    // Force-exit if server doesn't close within 5 seconds.
    setTimeout(() => {
      console.error('Server did not close in time - forcing exit.');
      process.exit(1);
    }, 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

startServer();
