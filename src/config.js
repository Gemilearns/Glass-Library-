// src/config.js — centralized config, fail loudly on bad/missing critical values
import "dotenv/config";

function bool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const cfg = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: num(process.env.PORT, 3000),
  DATABASE_URL: process.env.DATABASE_URL || "",

  R2: {
    ACCOUNT_ID: process.env.R2_ACCOUNT_ID || "",
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || "",
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "",
    BUCKET: process.env.R2_BUCKET_NAME || "glass-library",
    // Optional: explicit S3 endpoint override, for non-Cloudflare S3-compatible
    // providers (e.g. Backblaze B2: s3.us-west-004.backblazeb2.com).
    // If unset, falls back to Cloudflare's fixed R2 endpoint pattern using ACCOUNT_ID.
    ENDPOINT: process.env.R2_ENDPOINT || "",
  },

  // STORAGE_DRIVER: "r2" (default) or "local" (writes to ./local-storage/, signed URLs served by /local-blob/:key).
  // Use "local" for dev/smoke tests when you don't want to hit Cloudflare.
  STORAGE_DRIVER: (process.env.STORAGE_DRIVER || "r2").toLowerCase(),
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR || "./local-storage",

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  ENABLE_AI: bool(process.env.ENABLE_AI, false) && !!process.env.GEMINI_API_KEY,

  MAX_UPLOAD_BYTES: num(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
  SIGNED_URL_EXPIRES: num(process.env.SIGNED_URL_EXPIRES, 300),

  // AI rate queue: max requests per minute (free tier safe)
  AI_RPM: num(process.env.AI_RPM, 15),
};

// Validate only in production. In dev we tolerate partial config.
if (cfg.NODE_ENV === "production") {
  const required = ["DATABASE_URL"];
  for (const k of required) {
    if (!cfg[k] && k === "DATABASE_URL") {
      // No DB = nothing works. Crash fast.
      throw new Error(`Missing required env: ${k}`);
    }
  }
  // R2 + AI are optional in prod too — upload falls back gracefully.
  // ACCOUNT_ID is only required when no explicit ENDPOINT is set (i.e. plain Cloudflare R2).
  const hasEndpoint = !!(cfg.R2.ENDPOINT || cfg.R2.ACCOUNT_ID);
  if (!hasEndpoint || !cfg.R2.ACCESS_KEY_ID || !cfg.R2.SECRET_ACCESS_KEY) {
    console.warn(
      "[config] Object storage credentials missing — uploads will fail until configured (Part 7)"
    );
  }
  if (!cfg.ENABLE_AI) {
    console.warn(
      "[config] AI disabled (ENABLE_AI=false or GEMINI_API_KEY missing) — uploads use regex-only fallback"
    );
  }
}

export default cfg;