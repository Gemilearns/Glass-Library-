// src/lib/text.js — text extraction (pdf-parse, mammoth) + magic-byte validation + EXIF strip
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

// Allowed file types by extension-mapped mime + our internal "kind"
const ALLOWED = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "image/jpeg",
  "image/png",
]);

export const ALLOWED_MIMES = ALLOWED;

/**
 * Validate magic bytes via file-type. Returns { ok, kind, mime, ext } or { ok:false, reason }.
 * Never trust extension or Content-Type header.
 */
export async function validateFile(buffer) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: "empty_file" };
  }
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) {
    return { ok: false, reason: "unknown_file_type" };
  }
  if (!ALLOWED.has(detected.mime)) {
    return { ok: false, reason: `unsupported_type:${detected.mime}` };
  }
  const kind = mimeToKind(detected.mime);
  return { ok: true, mime: detected.mime, ext: detected.ext, kind };
}

function mimeToKind(mime) {
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime === "application/msword") return "doc";
  if (mime.includes("presentationml")) return "pptx";
  if (mime === "image/jpeg" || mime === "image/png") return "image";
  return "other";
}

/**
 * Extract text from a buffer. Returns "" on failure or for non-text kinds.
 */
export async function extractText(buffer, kind) {
  try {
    if (kind === "pdf") {
      const mod = await import("pdf-parse");
      const pdfParse = mod.default || mod;
      const out = await pdfParse(buffer);
      return (out.text || "").trim();
    }
    if (kind === "docx") {
      const out = await mammoth.extractRawText({ buffer });
      return (out.value || "").trim();
    }
    // doc, pptx, image: no text extraction in v1
    return "";
  } catch (err) {
    console.warn("[text] extract failed:", err?.message || err);
    return "";
  }
}

/**
 * Strip EXIF metadata from images. Re-encode to clean buffer.
 * Returns original buffer untouched for non-images.
 */
export async function stripImageMetadata(buffer, mime) {
  if (!mime || !(mime === "image/jpeg" || mime === "image/png")) return buffer;
  try {
    if (mime === "image/jpeg") {
      return await sharp(buffer).rotate().withMetadata({}).jpeg({ quality: 90 }).toBuffer();
    }
    return await sharp(buffer).png({ compressionLevel: 9 }).toBuffer();
  } catch (err) {
    console.warn("[text] strip EXIF failed (returning original):", err?.message || err);
    return buffer;
  }
}