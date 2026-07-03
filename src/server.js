// src/server.js — Fastify bootstrap
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import cfg from "./config.js";
import catalogRoutes from "./routes/catalog.js";
import searchRoutes from "./routes/search.js";
import uploadRoutes from "./routes/upload.js";
import recommendationRoutes from "./routes/recommendations.js";
import collectionRoutes from "./routes/collections.js";
import statsRoutes from "./routes/stats.js";
import prisma from "./lib/prisma.js";

const app = Fastify({
  logger: {
    level: cfg.NODE_ENV === "production" ? "info" : "debug",
    transport: cfg.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  },
  bodyLimit: 2 * cfg.MAX_UPLOAD_BYTES, // safety margin for multipart overhead
  trustProxy: true, // Render + proxies
});

async function start() {
  await app.register(sensible);
  await app.register(rateLimit, {
    global: true,
    max: 200, // baseline cap
    timeWindow: "1 minute",
    cache: 10_000,
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true },
    addHeaders: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true },
    keyGenerator: (req) => req.ip,
  });
  await app.register(multipart, {
    limits: { fileSize: cfg.MAX_UPLOAD_BYTES, files: 1 },
  });

  await app.register(catalogRoutes);
  await app.register(searchRoutes);
  await app.register(uploadRoutes);
  await app.register(recommendationRoutes);
  await app.register(collectionRoutes);
  await app.register(statsRoutes);

  // 404
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "not_found", path: req.url }));

  // Centralized error handler
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    return reply.code(500).send({ error: "internal_error" });
  });

  // Stricter rate limit specifically for download endpoint: 30/hr per IP
  app.addHook("onRoute", (route) => {
    if (route.method === "GET" && route.url.endsWith("/download")) {
      route.config = {
        ...route.config,
        rateLimit: { max: 30, timeWindow: "1 hour" },
      };
    }
  });

  try {
    // Smoke-check DB connection so we fail fast on Render if env vars missing.
    if (cfg.DATABASE_URL) {
      await prisma.$queryRaw`SELECT 1`;
      app.log.info("db connection ok");
    } else {
      app.log.warn("DATABASE_URL missing — DB endpoints will fail until configured");
    }
  } catch (err) {
    app.log.warn({ err: err?.message }, "db connection failed at boot (continuing)");
  }

  app.listen({ port: cfg.PORT, host: "0.0.0.0" }, (err, addr) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`glass-library listening on ${addr} (env=${cfg.NODE_ENV})`);
    app.log.info(`ai_enabled=${cfg.ENABLE_AI} max_upload_mb=${cfg.MAX_UPLOAD_BYTES / 1024 / 1024}`);
  });
}

start().catch((err) => {
  console.error("fatal boot error:", err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (sig) => {
  app.log.info(`received ${sig}, shutting down…`);
  try { await app.close(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));