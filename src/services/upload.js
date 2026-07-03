// src/services/upload.js — orchestrator for the full upload pipeline.
// See Part 5 of the build spec. Step numbers in comments map to spec.
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import prisma from "../lib/prisma.js";
import cfg from "../config.js";
import { uploadFile as r2Upload } from "../lib/storage.js";
import { validateFile, extractText, stripImageMetadata, ALLOWED_MIMES } from "../lib/text.js";
import { regexClassify, mergeClassificationSignals } from "../lib/classify.js";
import { classifyAndSummarize } from "../lib/ai.js";

const TITLE_FALLBACK_RE = /^(.+?)\.([a-z0-9]+)$/i;

function safeTitleFromFilename(filename) {
  if (!filename) return "Untitled";
  const m = filename.match(TITLE_FALLBACK_RE);
  return (m ? m[1] : filename).replace(/[_\-]+/g, " ").trim().slice(0, 200) || "Untitled";
}

function sanitizeKeyPart(s) {
  return String(s || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80) || "file";
}

async function findUnitForCode(unitCodeGuess) {
  if (!unitCodeGuess) return null;
  // Normalize to "ABC 123" form
  const normalized = unitCodeGuess.replace(/[-\s]+/g, " ").toUpperCase();
  const m = normalized.match(/^([A-Z]+)\s?(\d+)$/);
  if (!m) return null;
  const codeVariants = [
    `${m[1]} ${m[2]}`,
    `${m[1]}${m[2]}`,
    `${m[1]}-${m[2]}`,
  ];
  // Try each variant
  for (const code of codeVariants) {
    const unit = await prisma.unit.findFirst({
      where: { code: { equals: code, mode: "insensitive" } },
      select: { id: true, universityId: true },
    });
    if (unit) return unit;
  }
  return null;
}

async function findUniversityFromFilename(filename, text) {
  const blob = `${filename || ""} ${(text || "").slice(0, 800)}`.toLowerCase();
  // Cheap heuristic: look for known university names. Optional.
  const known = ["nairobi", "kenyatta", "strathmore", "jkuat", "maseno", "mku", "chuka", "kisii"];
  for (const k of known) {
    if (blob.includes(k)) {
      const u = await prisma.university.findFirst({
        where: { name: { contains: k, mode: "insensitive" } },
        select: { id: true },
      });
      if (u) return u.id;
    }
  }
  return null;
}

async function attachTags(documentId, tagNames) {
  if (!tagNames || tagNames.length === 0) return;
  const clean = [...new Set(tagNames.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 5);
  for (const name of clean) {
    // Find-or-create by case-insensitive name
    let tag = await prisma.tag.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
    if (!tag) {
      try {
        tag = await prisma.tag.create({ data: { name } });
      } catch {
        // Race: another insert won. Re-fetch.
        tag = await prisma.tag.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
        if (!tag) continue;
      }
    }
    await prisma.documentTag.upsert({
      where: { documentId_tagId: { documentId, tagId: tag.id } },
      update: {},
      create: { documentId, tagId: tag.id },
    });
  }
}

/**
 * Run the upload pipeline.
 * @param {object} args
 * @param {Buffer} args.buffer - raw file bytes
 * @param {string} args.filename - original filename
 * @param {string} args.uploaderId - bare string for now (real auth later)
 * @param {object} [args.metadata] - optional { unitId, universityId, year, examType, docType }
 */
export async function runUploadPipeline({ buffer, filename, uploaderId, metadata = {} }) {
  // Step 2: size cap
  if (buffer.length > cfg.MAX_UPLOAD_BYTES) {
    const err = new Error(`file_too_large: ${buffer.length} > ${cfg.MAX_UPLOAD_BYTES}`);
    err.code = "FILE_TOO_LARGE";
    throw err;
  }

  // Step 1: magic-byte validation
  const validation = await validateFile(buffer);
  if (!validation.ok) {
    const err = new Error(`invalid_file: ${validation.reason}`);
    err.code = "INVALID_FILE";
    throw err;
  }

  // Step 3: SHA-256
  const fileHash = createHash("sha256").update(buffer).digest("hex");

  // Step 4: dedup
  const existing = await prisma.document.findFirst({
    where: { fileHash },
    select: { id: true },
  });
  if (existing) {
    await prisma.documentContributor.upsert({
      where: { documentId_uploaderId: { documentId: existing.id, uploaderId: uploaderId || "anonymous" } },
      update: {},
      create: { documentId: existing.id, uploaderId: uploaderId || "anonymous" },
    });
    const doc = await prisma.document.findUnique({
      where: { id: existing.id },
      include: { tags: { include: { tag: true } } },
    });
    return {
      document_id: doc.id,
      status: doc.status,
      confidence_score: doc.confidenceScore,
      ai_summary: doc.aiSummary,
      deduplicated: true,
    };
  }

  // Step 5: upload to R2
  const docUuid = uuidv4();
  const key = `documents/${docUuid}/${sanitizeKeyPart(filename || "file")}`;
  await r2Upload(key, buffer, validation.mime);

  // Step 6: extract text + strip EXIF (images)
  let workingBuffer = buffer;
  if (validation.kind === "image") {
    workingBuffer = await stripImageMetadata(buffer, validation.mime);
    // Re-upload cleaned version if size changed meaningfully
    if (workingBuffer.length !== buffer.length) {
      try { await r2Upload(key, workingBuffer, validation.mime); } catch { /* keep original */ }
    }
  }
  const extractedText = await extractText(workingBuffer, validation.kind);

  // Step 7: regex classification
  const regex = regexClassify(filename, extractedText);

  // Step 8: AI classification (may return null on disable/failure)
  const ai = await classifyAndSummarize(extractedText, filename);

  // Step 9: merge signals
  const merged = mergeClassificationSignals(regex, ai);

  // Resolve unit: prefer metadata.unitId, else AI/regex guess
  let unitId = metadata.unitId || null;
  let universityId = metadata.universityId || null;
  if (!unitId && merged.unitCodeGuess) {
    const u = await findUnitForCode(merged.unitCodeGuess);
    if (u) {
      unitId = u.id;
      if (!universityId) universityId = u.universityId;
    }
  }
  if (!universityId) {
    universityId = await findUniversityFromFilename(filename, extractedText);
  }

  // Step 10: thumbnail — stub for v1 (deferred per spec Part 10)
  const thumbnailKey = null;

  // Step 11: insert document (status from merged), then write tsvector
  const title = metadata.title || safeTitleFromFilename(filename);
  const doc = await prisma.document.create({
    data: {
      title,
      docType: metadata.docType || merged.docType || "other",
      unitId,
      universityId,
      year: metadata.year ? Number(metadata.year) : null,
      examType: metadata.examType || null,
      uploaderId: uploaderId || "anonymous",
      fileKey: key,
      fileHash,
      fileSizeBytes: BigInt(buffer.length),
      pageCount: null,
      aiSummary: merged.summary,
      status: merged.status,
      confidenceScore: merged.confidence,
      thumbnailKey,
    },
  });

  // Contributor record
  await prisma.documentContributor.create({
    data: { documentId: doc.id, uploaderId: uploaderId || "anonymous" },
  });

  // Step 12: tsvector + tags (run after insert so we have an id)
  if (extractedText) {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Document" SET extracted_text = to_tsvector('english', $1) WHERE id = $2`,
        extractedText,
        doc.id
      );
    } catch (err) {
      console.warn("[upload] tsvector write failed (column missing? run npm run fts:migrate):", err?.message || err);
    }
  }
  await attachTags(doc.id, merged.tags);

  return {
    document_id: doc.id,
    status: doc.status,
    confidence_score: doc.confidenceScore,
    ai_summary: doc.aiSummary,
    deduplicated: false,
  };
}