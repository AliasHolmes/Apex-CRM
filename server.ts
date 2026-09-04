/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import "dotenv/config";
import express from "express";
import compression from "compression";
import path from "path";
import { createServer as createViteServer } from "vite";
import apiRouter from "./server/routes/api.js";
import {
  getLeadsDb,
  pruneExpiredEnrichmentCache,
  reconcileOrphanedMiningSessions,
} from "./server/db.js";
import { validateEngineConfig } from "./server/configValidation.js";
import { isAllowedHost, isAllowedOrigin } from "./server/hostValidation.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const isProduction =
  process.env.NODE_ENV === "production" ||
  process.argv.includes("--production");
const scriptSourcePolicy = isProduction ? "'self'" : "'self' 'unsafe-inline'";

// Request timing & performance monitoring (disabled by default; toggle with APEX_PERF_LOGS=true)
if (process.env.APEX_PERF_LOGS === "true") {
  const slowThreshold = Number(process.env.APEX_PERF_SLOW_THRESHOLD_MS) || 2000;
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const isStreaming =
        req.originalUrl?.includes("/stream") ||
        req.originalUrl?.includes("/live") ||
        req.originalUrl?.includes("/find-leads") ||
        res.getHeader("content-type")?.toString().includes("text/event-stream");
      if (req.originalUrl?.startsWith("/api") && !isStreaming && duration > slowThreshold) {
        console.log(
          `[PERF] Slow API request: ${req.method} ${req.originalUrl} (${duration}ms)`,
        );
      }
    });
    next();
  });
}

// This is a single-user, local desktop service. Keep it loopback-only and avoid
// accepting arbitrarily large bodies before an API handler has a chance to validate them.
app.disable("x-powered-by");
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src ${scriptSourcePolicy}; base-uri 'self'; frame-ancestors 'none'`,
  );
  next();
});
app.use(
  compression({
    filter: (req, res) => {
      if (req.headers["accept"]?.includes("text/event-stream")) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);
app.use(express.json({ limit: "10mb" }));

// DNS-Rebinding Guard
// Validates Host and Origin headers on every API request. Even though the server is
// bound to 127.0.0.1, a malicious page open in the user's browser can still reach
// localhost via same-machine loopback unless we explicitly reject non-loopback Host values.
app.use(
  "/api",
  (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): any => {
    if (!isAllowedHost(req.headers.host || "", PORT, req.socket?.localPort)) {
      return res
        .status(400)
        .type("text/plain")
        .send(
          "Invalid Host header. Direct API access from non-loopback origins is blocked.",
        );
    }

    if (!isAllowedOrigin(req.headers.origin, PORT)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Cross-origin API access is blocked.");
    }

    next();
  },
);

// Mount the API router. /api/v1 is a versioning seam aliasing /api so future
// breaking changes can land at /api/v2 without disturbing existing clients.
app.use("/api", apiRouter);
app.use("/api/v1", apiRouter);
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (error instanceof SyntaxError && "body" in error) {
      return res
        .status(400)
        .json({ error: "Request body must be valid JSON." });
    }
    if (
      typeof error === "object" &&
      error &&
      "type" in error &&
      (error as { type?: string }).type === "entity.too.large"
    ) {
      return res
        .status(413)
        .json({ error: "Request body exceeds the 10 MB limit." });
    }
    return next(error);
  },
);

// -----------------------------------------------------------------------------
// Dev & Build Routing Setup
// -----------------------------------------------------------------------------

async function startServer() {
  // Eagerly warm up the database during startup
  try {
    getLeadsDb();
    console.log("Database initialized and warmed up.");
    for (const warning of validateEngineConfig()) {
      console.warn(`[Config] ${warning}`);
    }
    const reconciled = reconcileOrphanedMiningSessions();
    if (reconciled > 0) {
      console.log(
        `[Startup] Reconciled ${reconciled} orphaned mining sessions to 'interrupted'.`,
      );
    }
  } catch (error) {
    console.error("Failed to eagerly initialize database:", error);
    process.exitCode = 1;
    return;
  }

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use((req, res, next) => {
      if (/\.(?:cjs|map)$/i.test(req.path)) return res.sendStatus(404);
      return next();
    });
    app.use(
      express.static(distPath, {
        index: false,
        maxAge: "1h",
        setHeaders: (res, filePath) => {
          if (path.basename(filePath) === "index.html") {
            res.setHeader("Cache-Control", "no-store");
          }
        },
      }),
    );
    // Express 5 uses path-to-regexp v8, where a catch-all must be named.
    app.get("/{*splat}", (req, res) => {
      if (path.extname(req.path)) return res.sendStatus(404);
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(
      `Server launched at http://${HOST}:${PORT} in ${isProduction ? "production" : "development"} mode.`,
    );
  });

  server.on("error", (error) => {
    console.error(`Unable to start Apex CRM on ${HOST}:${PORT}:`, error);
    process.exitCode = 1;
  });

  // Periodically prune expired enrichment cache and optimize SQLite indices (every 30 mins)
  const MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;
  const maintenanceTimer = setInterval(() => {
    try {
      const db = getLeadsDb();
      const pruned = pruneExpiredEnrichmentCache();
      if (pruned > 0)
        console.log(
          `[Maintenance] Pruned ${pruned} expired enrichment cache records.`,
        );
      db.exec("PRAGMA optimize;");
    } catch (err) {
      console.warn("[Maintenance] Scheduled optimization failed:", err);
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  const shutdown = (signal: string) => {
    clearInterval(maintenanceTimer);
    console.log(`\n[${signal}] Shutting down Apex CRM server gracefully...`);
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
    // Mark any active mining sessions as interrupted so the DB is consistent.
    try {
      const reconciled = reconcileOrphanedMiningSessions(
        `Server process exited (${signal}).`,
      );
      if (reconciled > 0) {
        console.log(
          `[Shutdown:${signal}] Marked ${reconciled} active mining session(s) as 'interrupted'.`,
        );
      }
    } catch (dbErr) {
      console.warn("Could not update interrupted mining sessions:", dbErr);
    }
    // Force-exit if server doesn't close within 5 seconds.
    setTimeout(() => {
      console.error("Server did not close in time - forcing exit.");
      process.exit(1);
    }, 5_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
