// scripts/apply-fts.js — backwards-compat no-op.
// FTS migration is now part of the init Prisma migration
// (see prisma/migrations/*_init/migration.sql tail).
// Kept as `npm run fts:migrate` for spec compat.
console.log("[fts] tsvector + GIN index are part of the init migration.");
console.log("[fts] If running on an existing DB without FTS, run:");
console.log("[fts]   ALTER TABLE \\\"Document\\\" ADD COLUMN IF NOT EXISTS extracted_text tsvector;");
console.log("[fts]   CREATE INDEX IF NOT EXISTS idx_document_search ON \\\"Document\\\" USING GIN (extracted_text);");