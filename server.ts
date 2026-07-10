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
    "default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});
app.use(express.json({ limit: '1mb' }));

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
}

startServer();
