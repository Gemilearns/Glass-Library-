// src/lib/storage.js — Cloudflare R2 (S3-compatible) or local filesystem driver
// See Part 3 of the build spec. Switch via STORAGE_DRIVER env (r2 | local).
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import cfg from "../config.js";

let _s3 = null;

function r2Client() {
  if (_s3) return _s3;
  const endpoint = cfg.R2.ENDPOINT
    ? (cfg.R2.ENDPOINT.startsWith("http") ? cfg.R2.ENDPOINT : `https://${cfg.R2.ENDPOINT}`)
    : cfg.R2.ACCOUNT_ID
      ? `https://${cfg.R2.ACCOUNT_ID}.r2.cloudflarestorage.com`
      : null;

  if (!endpoint || !cfg.R2.ACCESS_KEY_ID || !cfg.R2.SECRET_ACCESS_KEY) {
    throw new Error(
      "Object storage credentials not configured. Set R2_ENDPOINT (or R2_ACCOUNT_ID for Cloudflare), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (Part 7) — or set STORAGE_DRIVER=local for dev."
    );
  }
  // Backblaze B2's S3 endpoint requires path-style addressing (bucket in URL path,
  // not as a subdomain) — Cloudflare R2 works with either, so this is safe for both.
  _s3 = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.R2.ACCESS_KEY_ID,
      secretAccessKey: cfg.R2.SECRET_ACCESS_KEY,
    },
  });
  return _s3;
}

// ---------------- Local filesystem driver ----------------
// Writes to LOCAL_STORAGE_DIR. Signed URLs are HMAC-signed and served by /local-blob/:key/:sig.
// Only meant for dev / smoke tests — DO NOT enable in prod.

function localPath(key) {
  // Hard-bound to storage dir to prevent traversal
  const root = resolve(cfg.LOCAL_STORAGE_DIR);
  const target = resolve(root, key);
  if (!target.startsWith(root + "/") && target !== root) {
    throw new Error("invalid_key_path");
  }
  return target;
}

async function ensureLocalDir(key) {
  await mkdir(dirname(localPath(key)), { recursive: true });
}

function localSign(key, expiresIn) {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = createHmac("sha256", "local-storage-dev-secret").update(`${key}|${exp}`).digest("hex").slice(0, 32);
  return { sig, exp };
}

// ---------------- Public API ----------------

export async function uploadFile(key, buffer, contentType) {
  if (cfg.STORAGE_DRIVER === "local") {
    await ensureLocalDir(key);
    await writeFile(localPath(key), buffer);
    return key;
  }
  await r2Client().send(
    new PutObjectCommand({
      Bucket: cfg.R2.BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return key;
}

export async function getSignedDownloadUrl(key, expiresIn = cfg.SIGNED_URL_EXPIRES) {
  if (cfg.STORAGE_DRIVER === "local") {
    const { sig, exp } = localSign(key, expiresIn);
    // Host injected by caller via cfg.BASE_URL? We don't have it here. Use a stable relative path.
    // The catalog route constructs an absolute URL using req.protocol + req.headers.host for local driver.
    return `/local-blob/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  }
  const command = new GetObjectCommand({ Bucket: cfg.R2.BUCKET, Key: key });
  return getSignedUrl(r2Client(), command, { expiresIn });
}

export async function deleteFile(key) {
  if (cfg.STORAGE_DRIVER === "local") {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(localPath(key));
    } catch { /* ignore */ }
    return;
  }
  await r2Client().send(new DeleteObjectCommand({ Bucket: cfg.R2.BUCKET, Key: key }));
}

// Local-only: verify a signed URL and return the buffer.
export async function readLocalSigned(key, exp, sig) {
  if (cfg.STORAGE_DRIVER !== "local") throw new Error("local driver not active");
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) < now) throw new Error("url_expired");
  const expected = createHmac("sha256", "local-storage-dev-secret").update(`${key}|${exp}`).digest("hex").slice(0, 32);
  if (expected !== sig) throw new Error("bad_signature");
  return readFile(localPath(key));
}