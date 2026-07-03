// src/routes/upload.js — multipart upload endpoint + moderation queue
import prisma from "../lib/prisma.js";
import { runUploadPipeline } from "../services/upload.js";

const DOC_INCLUDE = {
  unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
  university: true,
  tags: { include: { tag: true } },
};

function serialize(d) {
  return {
    id: d.id,
    title: d.title,
    doc_type: d.docType,
    year: d.year,
    exam_type: d.examType,
    status: d.status,
    confidence_score: d.confidenceScore,
    ai_summary: d.aiSummary,
    download_count: d.downloadCount,
    view_count: d.viewCount,
    created_at: d.createdAt,
    unit: d.unit ? {
      id: d.unit.id, code: d.unit.code, title: d.unit.title,
      department: d.unit.department.name,
      faculty: d.unit.department.faculty.name,
      university: d.unit.department.faculty.university.name,
    } : null,
    university: d.university ? { id: d.university.id, name: d.university.name } : null,
    tags: d.tags.map((t) => t.tag.name),
  };
}

export default async function uploadRoutes(app) {
  // POST /api/documents/upload — multipart
  app.post("/api/documents/upload", {
    config: {
      rateLimit: { max: 10, timeWindow: "1 hour" },
    },
  }, async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "expected_multipart" });
    }

    let fileBuf = null;
    let filename = null;
    let uploaderId = null;
    const metadata = {};

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        const chunks = [];
        for await (const c of part.file) chunks.push(c);
        fileBuf = Buffer.concat(chunks);
        filename = part.filename;
      } else if (part.type === "field") {
        const k = String(part.fieldname);
        const v = String(part.value);
        if (k === "uploader_id") uploaderId = v;
        else if (["unit_id", "university_id", "year", "exam_type", "doc_type", "title"].includes(k)) {
          metadata[k === "unit_id" ? "unitId" : k === "university_id" ? "universityId" : k] = v;
        }
      }
    }

    if (!fileBuf) return reply.code(400).send({ error: "missing_file" });

    try {
      const result = await runUploadPipeline({
        buffer: fileBuf,
        filename,
        uploaderId: uploaderId || req.headers["x-user-ref"] || req.ip,
        metadata,
      });
      return reply.code(result.deduplicated ? 200 : 201).send(result);
    } catch (err) {
      if (err.code === "FILE_TOO_LARGE" || err.code === "INVALID_FILE") {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      req.log.error({ err }, "upload pipeline failed");
      return reply.code(500).send({ error: "upload_failed", detail: err.message });
    }
  });

  // GET /api/documents/pending — moderation queue
  app.get("/api/documents/pending", async (req) => {
    const docs = await prisma.document.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: DOC_INCLUDE,
    });
    return {
      count: docs.length,
      documents: docs.map(serialize),
    };
  });

  // PATCH /api/documents/:id/moderate — approve / reject / flag
  app.patch("/api/documents/:id/moderate", async (req, reply) => {
    const { id } = req.params;
    const { status, tags } = req.body || {};
    const allowed = new Set(["approved", "flagged", "rejected", "pending"]);
    if (!allowed.has(status)) {
      return reply.code(400).send({ error: "invalid_status", allowed: [...allowed] });
    }
    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) return reply.code(404).send({ error: "not_found" });

    const updated = await prisma.document.update({
      where: { id },
      data: { status, confidenceScore: status === "approved" ? Math.max(0.9, doc.confidenceScore) : doc.confidenceScore },
      include: DOC_INCLUDE,
    });

    if (Array.isArray(tags)) {
      // Replace tags wholesale on moderation
      await prisma.documentTag.deleteMany({ where: { documentId: id } });
      for (const name of tags) {
        const clean = String(name).toLowerCase().trim();
        if (!clean) continue;
        let tag = await prisma.tag.findFirst({ where: { name: { equals: clean, mode: "insensitive" } } });
        if (!tag) {
          try {
            tag = await prisma.tag.create({ data: { name: clean } });
          } catch {
            tag = await prisma.tag.findFirst({ where: { name: { equals: clean, mode: "insensitive" } } });
            if (!tag) continue;
          }
        }
        await prisma.documentTag.create({ data: { documentId: id, tagId: tag.id } });
      }
    }

    return { document: serialize(updated) };
  });
}