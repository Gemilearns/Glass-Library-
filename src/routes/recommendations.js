// src/routes/recommendations.js — related (co-occurrence) + trending (7d velocity)
import prisma from "../lib/prisma.js";

function serialize(d) {
  return {
    id: d.id,
    title: d.title,
    doc_type: d.docType,
    year: d.year,
    ai_summary: d.aiSummary,
    download_count: d.downloadCount,
    view_count: d.viewCount,
    confidence_score: d.confidenceScore,
    created_at: d.createdAt,
    unit: d.unit ? {
      id: d.unit.id, code: d.unit.code, title: d.unit.title,
      department: d.unit.department.name,
      faculty: d.unit.department.faculty.name,
      university: d.unit.department.faculty.university.name,
    } : null,
    university: d.university ? { id: d.university.id, name: d.university.name } : null,
    tags: d.tags ? d.tags.map((t) => t.tag.name) : [],
  };
}

export default async function recommendationRoutes(app) {
  // GET /api/documents/:id/related — documents sharing unit, university, or co-downloaded
  app.get("/api/documents/:id/related", async (req, reply) => {
    const { id } = req.params;
    const doc = await prisma.document.findUnique({
      where: { id },
      select: { id: true, unitId: true, universityId: true },
    });
    if (!doc) return reply.code(404).send({ error: "not_found" });

    // Strategy: same unit OR same university, excluding self, approved, ordered by downloads.
    const related = await prisma.document.findMany({
      where: {
        id: { not: id },
        status: "approved",
        OR: [
          doc.unitId ? { unitId: doc.unitId } : undefined,
          doc.universityId ? { universityId: doc.universityId } : undefined,
        ].filter(Boolean),
      },
      orderBy: [{ downloadCount: "desc" }, { createdAt: "desc" }],
      take: 10,
      include: {
        unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
        university: true,
        tags: { include: { tag: true } },
      },
    });

    return { related: related.map(serialize) };
  });

  // GET /api/documents/trending — download velocity last 7 days
  app.get("/api/documents/trending", async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Count downloads per document in window
    const grouped = await prisma.download.groupBy({
      by: ["documentId"],
      where: { downloadedAt: { gte: since } },
      _count: { documentId: true },
      orderBy: { _count: { documentId: "desc" } },
      take: 20,
    });
    const ids = grouped.map((g) => g.documentId);
    if (ids.length === 0) return { trending: [], window_days: 7 };
    const docs = await prisma.document.findMany({
      where: { id: { in: ids }, status: "approved" },
      include: {
        unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
        university: true,
        tags: { include: { tag: true } },
      },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    const trending = grouped
      .map((g) => {
        const d = byId.get(g.documentId);
        if (!d) return null;
        return { ...serialize(d), recent_downloads: g._count.documentId };
      })
      .filter(Boolean);
    return { window_days: 7, trending };
  });

  // GET /api/units/:id/documents/trending — same, scoped to a unit
  app.get("/api/units/:id/documents/trending", async (req, reply) => {
    const { id } = req.params;
    const unit = await prisma.unit.findUnique({ where: { id } });
    if (!unit) return reply.code(404).send({ error: "not_found" });

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const grouped = await prisma.download.groupBy({
      by: ["documentId"],
      where: { downloadedAt: { gte: since }, document: { unitId: id } },
      _count: { documentId: true },
      orderBy: { _count: { documentId: "desc" } },
      take: 20,
    });
    const ids = grouped.map((g) => g.documentId);
    const docs = await prisma.document.findMany({
      where: { id: { in: ids }, status: "approved" },
      include: {
        unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
        university: true,
        tags: { include: { tag: true } },
      },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return {
      unit: { id: unit.id, code: unit.code, title: unit.title },
      window_days: 7,
      trending: grouped
        .map((g) => {
          const d = byId.get(g.documentId);
          if (!d) return null;
          return { ...serialize(d), recent_downloads: g._count.documentId };
        })
        .filter(Boolean),
    };
  });
}