// src/routes/search.js — Postgres FTS ranked by relevance × popularity × recency
// See Part 6 "Search query" of the build spec.
import prisma from "../lib/prisma.js";

export default async function searchRoutes(app) {
  app.get("/api/search", async (req, reply) => {
    const { q, unit, type, year, sort = "relevance" } = req.query;
    const query = String(q || "").trim();
    if (!query) return reply.code(400).send({ error: "missing_query" });

    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    // Spec's relevance ranking
    if (sort === "relevance") {
      try {
        const rows = await prisma.$queryRawUnsafe(
          `
          SELECT id, title, "docType", "aiSummary", "downloadCount", "viewCount",
                 "createdAt", "confidenceScore", "unitId", "universityId",
                 ts_rank(extracted_text, plainto_tsquery('english', $1)) AS rel,
                 ts_rank(extracted_text, plainto_tsquery('english', $1)) *
                 (1 + ln("downloadCount" + 1)) *
                 (1 / (1 + extract(epoch from now() - "createdAt") / 31536000)) AS score
          FROM "Document"
          WHERE status = 'approved'
            AND extracted_text @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $2;
          `,
          query,
          limit
        );
        const results = await attachRelations(rows, { unit, type, year });
        return { query, sort, count: results.length, results };
      } catch (err) {
        // Most common cause: tsvector column missing. Fall back to LIKE.
        console.warn("[search] FTS query failed, falling back to LIKE:", err?.message || err);
        return fallbackLike(query, { unit, type, year }, limit);
      }
    }

    // recent | popular
    return fallbackLike(query, { unit, type, year }, limit, sort);
  });
}

async function attachRelations(rows, filters) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const docs = await prisma.document.findMany({
    where: { id: { in: ids } },
    include: {
      unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
      university: true,
      tags: { include: { tag: true } },
    },
  });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const filtered = rows
    .map((r) => byId.get(r.id))
    .filter(Boolean)
    .filter((d) => {
      if (filters.unit && d.unit?.id !== filters.unit) return false;
      if (filters.type && d.docType !== filters.type) return false;
      if (filters.year && String(d.year) !== String(filters.year)) return false;
      return true;
    })
    .map((d) => ({
      id: d.id,
      title: d.title,
      doc_type: d.docType,
      ai_summary: d.aiSummary,
      confidence_score: d.confidenceScore,
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
    }));
  return filtered;
}

async function fallbackLike(query, filters, limit, sort = "recent") {
  const where = {
    status: "approved",
    OR: [
      { title: { contains: query, mode: "insensitive" } },
      { aiSummary: { contains: query, mode: "insensitive" } },
    ],
  };
  if (filters.type) where.docType = String(filters.type);
  if (filters.year) where.year = Number(filters.year);

  const orderBy =
    sort === "popular"
      ? { downloadCount: "desc" }
      : sort === "recent"
      ? { createdAt: "desc" }
      : { createdAt: "desc" };

  const docs = await prisma.document.findMany({
    where,
    orderBy,
    take: limit,
    include: {
      unit: { include: { department: { include: { faculty: { include: { university: true } } } } } },
      university: true,
      tags: { include: { tag: true } },
    },
  });
  const filtered = filters.unit
    ? docs.filter((d) => d.unit?.id === filters.unit)
    : docs;
  return {
    query,
    sort,
    count: filtered.length,
    fallback: "like",
    results: filtered.map((d) => ({
      id: d.id,
      title: d.title,
      doc_type: d.docType,
      ai_summary: d.aiSummary,
      confidence_score: d.confidenceScore,
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
    })),
  };
}