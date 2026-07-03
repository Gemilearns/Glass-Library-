// src/routes/collections.js — minimal collections logic (spec: "schema ready, minimal logic")
import prisma from "../lib/prisma.js";

export default async function collectionRoutes(app) {
  // POST /api/collections — create a collection
  app.post("/api/collections", async (req, reply) => {
    const { title, description, is_public, owner_id } = req.body || {};
    if (!title) return reply.code(400).send({ error: "missing_title" });
    const collection = await prisma.collection.create({
      data: {
        title: String(title),
        description: description ? String(description) : null,
        isPublic: is_public !== false,
        ownerId: owner_id || req.headers["x-user-ref"] || req.ip || "anonymous",
      },
    });
    return reply.code(201).send({ collection });
  });

  // GET /api/collections/:id — fetch metadata
  app.get("/api/collections/:id", async (req, reply) => {
    const { id } = req.params;
    const c = await prisma.collection.findUnique({ where: { id } });
    if (!c) return reply.code(404).send({ error: "not_found" });
    return { collection: c };
  });

  // POST /api/collections/:id/documents/:doc_id — add document to collection
  // Schema doesn't have a join table yet; this is a stub that records intent
  // by returning 501 until the join model is added in a future migration.
  app.post("/api/collections/:id/documents/:doc_id", async (req, reply) => {
    return reply.code(501).send({
      error: "not_implemented",
      message: "Collection-document join table is deferred to phase 2 (spec Part 10).",
    });
  });
}