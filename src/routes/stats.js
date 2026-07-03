// src/routes/stats.js — overview counters
import prisma from "../lib/prisma.js";

export default async function statsRoutes(app) {
  app.get("/api/stats/overview", async () => {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      universities,
      units,
      totalDocs,
      approvedDocs,
      pendingDocs,
      flaggedDocs,
      rejectedDocs,
      totalDownloads,
      downloadsLast7d,
      totalViews,
      totalContributors,
    ] = await Promise.all([
      prisma.university.count(),
      prisma.unit.count(),
      prisma.document.count(),
      prisma.document.count({ where: { status: "approved" } }),
      prisma.document.count({ where: { status: "pending" } }),
      prisma.document.count({ where: { status: "flagged" } }),
      prisma.document.count({ where: { status: "rejected" } }),
      prisma.download.count(),
      prisma.download.count({ where: { downloadedAt: { gte: since7d } } }),
      prisma.view.count(),
      prisma.documentContributor.count(),
    ]);

    return {
      universities,
      units,
      documents: {
        total: totalDocs,
        approved: approvedDocs,
        pending: pendingDocs,
        flagged: flaggedDocs,
        rejected: rejectedDocs,
      },
      downloads: { total: totalDownloads, last_7d: downloadsLast7d },
      views: { total: totalViews },
      contributors: totalContributors,
      generated_at: new Date().toISOString(),
    };
  });
}