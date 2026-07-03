# Glass Library — Backend

Fastify + Prisma + Postgres (Neon) + Cloudflare R2 + Google Gemini.

See the build spec for full design rationale. This README is just the deploy cheat sheet.

---

## Local dev

```bash
cp .env.example .env       # fill in DATABASE_URL at minimum
npm install
npx prisma migrate dev     # creates tables + applies fts.sql automatically (see prisma/migrations/sql)
npm run db:seed            # sample universities / faculties / units
npm run dev                # starts on http://localhost:3000
curl http://localhost:3000/health
```

The Prisma migration system picks up SQL files via `prisma migrate dev --create-only` — but for the `tsvector` + GIN index we ship a separate runner:

```bash
npm run fts:migrate        # safe to re-run; idempotent
```

If you skip `prisma migrate deploy` on Render and rely on raw SQL only, add this line to the `render.yaml` `buildCommand`:

```
buildCommand: npm install && npx prisma generate && npx prisma migrate deploy && npm run fts:migrate
```

---

## Environment Variables (the only thing Braddock configures)

Get each from its dashboard, paste into Render → Web Service → Environment tab:

| Var | Source |
|---|---|
| `DATABASE_URL` | neon.tech → New Project → connection string |
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → Account ID |
| `R2_ACCESS_KEY_ID` | R2 → Manage API Tokens → create token |
| `R2_SECRET_ACCESS_KEY` | (shown once when creating the token) |
| `R2_BUCKET_NAME` | `glass-library` (create the bucket first) |
| `GEMINI_API_KEY` | aistudio.google.com/apikey |

Optional:
- `ENABLE_AI` (default `false` in dev, `true` in prod) — gates Gemini calls
- `MAX_UPLOAD_MB` (default 50)
- `SIGNED_URL_EXPIRES` (default 300 = 5 min)

---

## Deploy to Render

1. Push this repo to GitHub
2. Render → New → Web Service → connect repo
3. Render auto-detects `render.yaml`. Confirm.
4. Open the **Environment** tab, paste all the secrets from above
5. Click **Manual Deploy → Deploy latest commit**
6. Wait for the build (~2-3 min). Health check hits `/health`.
7. Once live, run the seed against the prod DB once:
   ```bash
   DATABASE_URL=<your-neon-url> npm run db:seed
   npm run fts:migrate
   ```

---

## API quick reference

```
GET  /health
GET  /api/universities
GET  /api/units?department_id=&search=
GET  /api/documents?unit_id=&type=&year=&status=&page=&limit=
GET  /api/documents/:id
GET  /api/documents/:id/download
GET  /api/search?q=&unit=&type=&year=&sort=relevance|recent|popular
POST /api/documents/upload                      (multipart)
GET  /api/documents/pending                     (moderation queue)
PATCH /api/documents/:id/moderate               { status, tags? }
GET  /api/documents/:id/related
GET  /api/documents/trending
GET  /api/units/:id/documents/trending
POST /api/collections
GET  /api/collections/:id
POST /api/collections/:id/documents/:doc_id    (501 stub)
GET  /api/stats/overview
```

Upload multipart fields:
- file (binary)
- uploader_id (string, stub)
- unit_id, university_id, year, exam_type, doc_type, title (optional metadata)

---

## Pre-deploy checklist

- [ ] `npm install` clean
- [ ] Prisma migration runs against Neon dev branch
- [ ] Upload a real PDF → text extraction + classification + R2 storage all succeed
- [ ] Upload the same file twice → dedup returns the existing doc
- [ ] `GET /api/search?q=…` returns ranked results
- [ ] Download endpoint returns a signed URL that expires in 5 minutes
- [ ] `GET /health` returns 200
- [ ] Empty `GEMINI_API_KEY` → upload still succeeds via regex fallback

Run `npm run smoke` against a running local instance for an automated pass.

---

## Deferred (per spec Part 10)

- Real JWT auth — `uploaderId` is a bare string until then
- Collections full logic — schema + minimal endpoints only
- Thumbnail generation — stub for v1
- Gemini search query expansion