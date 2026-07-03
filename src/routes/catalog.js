// src/routes/catalog.js — universities, units, documents list/get, download
import prisma from "../lib/prisma.js";
import { getSignedDownloadUrl, readLocalSigned } from "../lib/storage.js";
import cfg from "../config.js";

const DOC_INCLUDE = {
  unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
  university: true,
  tags: { include: { tag: true } },
};

function serializeDocument(d) {
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
    file_size_bytes: d.fileSizeBytes ? Number(d.fileSizeBytes) : null,
    thumbnail_key: d.thumbnailKey,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    unit: d.unit
      ? {
          id: d.unit.id,
          code: d.unit.code,
          title: d.unit.title,
          department: d.unit.department.name,
          faculty: d.unit.department.faculty.name,
          university: d.unit.department.faculty.university.name,
        }
      : null,
    university: d.university ? { id: d.university.id, name: d.university.name } : null,
    tags: d.tags.map((t) => t.tag.name),
  };
}

export default async function catalogRoutes(app) {
  // Health
  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // Universities
  app.get("/api/universities", async () => {
    const unis = await prisma.university.findMany({
      orderBy: { name: "asc" },
      include: {
        faculties: {
          include: {
            departments: {
              include: { _count: { select: { units: true } } },
            },
          },
        },
        _count: { select: { documents: true } },
      },
    });
    return {
      universities: unis.map((u) => ({
        id: u.id,
        name: u.name,
        country: u.country,
        document_count: u._count.documents,
        faculties: u.faculties.map((f) => ({
          id: f.id,
          name: f.name,
          departments: f.departments.map((d) => ({
            id: d.id,
            name: d.name,
            unit_count: d._count.units,
          })),
        })),
      })),
    };
  });

  // Units (with optional filter)
  app.get("/api/units", async (req) => {
    const { department_id, search } = req.query;
    const where = {};
    if (department_id) where.departmentId = String(department_id);
    if (search) {
      where.OR = [
        { code: { contains: String(search), mode: "insensitive" } },
        { title: { contains: String(search), mode: "insensitive" } },
      ];
    }
    const units = await prisma.unit.findMany({
      where,
      orderBy: { code: "asc" },
      include: {
        department: { include: { faculty: { include: { university: true } } } },
        _count: { select: { documents: true } },
      },
      take: 200,
    });
    return {
      units: units.map((u) => ({
        id: u.id,
        code: u.code,
        title: u.title,
        department: u.department.name,
        faculty: u.department.faculty.name,
        university: u.department.faculty.university.name,
        document_count: u._count.documents,
      })),
    };
  });

  // Documents list (default: status=approved)
  app.get("/api/documents", async (req) => {
    const { unit_id, type, year, status, page = "1", limit = "20" } = req.query;
    const where = {};
    if (unit_id) where.unitId = String(unit_id);
    if (type) where.docType = String(type);
    if (year) where.year = Number(year);
    where.status = status ? String(status) : "approved";

    const take = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (Math.max(1, Number(page) || 1) - 1) * take;

    const [docs, total] = await Promise.all([
      prisma.document.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: DOC_INCLUDE,
        skip,
        take,
      }),
      prisma.document.count({ where }),
    ]);

    return {
      page: Number(page) || 1,
      limit: take,
      total,
      documents: docs.map(serializeDocument),
    };
  });

  // Single document detail + view log
  app.get("/api/documents/:id", async (req, reply) => {
    const { id } = req.params;
    const doc = await prisma.document.findUnique({
      where: { id },
      include: DOC_INCLUDE,
    });
    if (!doc) return reply.code(404).send({ error: "not_found" });

    // Increment view count + log
    const userRef = req.headers["x-user-ref"] || req.ip;
    await Promise.all([
      prisma.document.update({ where: { id }, data: { viewCount: { increment: 1 } } }),
      prisma.view.create({ data: { documentId: id, userRef } }),
    ]);

    return { document: serializeDocument(doc) };
  });

  // Download: returns signed URL + logs the download
  app.get("/api/documents/:id/download", async (req, reply) => {
    const { id } = req.params;
    const doc = await prisma.document.findUnique({
      where: { id },
      select: { id: true, fileKey: true, status: true },
    });
    if (!doc) return reply.code(404).send({ error: "not_found" });
    if (doc.status !== "approved") {
      return reply.code(403).send({ error: "not_approved", status: doc.status });
    }

    const userRef = req.headers["x-user-ref"] || req.ip;
    let url = await getSignedDownloadUrl(doc.fileKey);
    // Local driver returns a relative path — convert to absolute using req.headers.host.
    if (url.startsWith("/")) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
      const host = req.headers.host;
      url = `${proto}://${host}${url}`;
    }

    await Promise.all([
      prisma.document.update({ where: { id }, data: { downloadCount: { increment: 1 } } }),
      prisma.download.create({ data: { documentId: id, userRef } }),
    ]);

    return { url, expires_in: 300 };
  });

  // Local storage signed-URL endpoint (only when STORAGE_DRIVER=local)
  if (cfg.STORAGE_DRIVER === "local") {
    app.get("/local-blob/:key", async (req, reply) => {
      const key = decodeURIComponent(req.params.key);
      const exp = req.query.exp;
      const sig = req.query.sig;
      try {
        const buf = await readLocalSigned(key, exp, sig);
        reply.header("Content-Type", "application/octet-stream");
        return reply.send(buf);
      } catch (err) {
        return reply.code(403).send({ error: err.message || "forbidden" });
      }
    });
  }
}