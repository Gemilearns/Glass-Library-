// scripts/smoke-test.js — automated pass against the pre-deploy checklist.
// Requires: server running on $BASE_URL (default http://localhost:3000)
//
// What it checks:
//  [x] /health returns 200
//  [x] /api/universities returns list (seed must be run)
//  [x] Upload a real PDF → 201 + document_id
//  [x] Upload same PDF again → 200 + deduplicated: true
//  [x] Moderation approves the doc
//  [x] /api/search returns the uploaded doc (via title LIKE fallback)
//  [x] /api/documents/:id returns the doc + bumps view counter
//  [x] /api/documents/:id/download returns a signed URL
//  [x] /api/stats/overview returns counters
//  [x] Invalid file is rejected at upload
//
// Pass `BASE_URL=...` to point at a remote instance.

import { fileTypeFromBuffer } from "file-type";

const BASE = process.env.BASE_URL || "http://localhost:3000";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "✓" : "✗";
  console.log(`${tag} ${name}${detail ? `  — ${detail}` : ""}`);
}

// Hand-crafted minimal PDF. Valid for file-type magic-byte detection and
// pdf-parse intake; the structural quirks in pdf-parse@1.x mean we don't
// rely on text extraction working from this synthetic PDF — we test the
// search pipeline via title LIKE fallback instead.
function buildTinyPdf(text) {
  const objs = [];
  objs.push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj");
  objs.push("2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj");
  objs.push(
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj`
  );
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, " ")}) Tj ET`;
  objs.push(`4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`);
  objs.push("5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj");

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o + "\n";
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += off.toString().padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

async function call(method, path, { body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, body, headers });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, data };
}

async function main() {
  console.log(`smoke test against ${BASE}\n`);

  // 1. health
  try {
    const { status, data } = await call("GET", "/health");
    record("health 200", status === 200 && data?.ok === true, `status=${status}`);
  } catch (e) {
    record("health 200", false, String(e));
    return finish();
  }

  // 2. universities
  const { status: us, data: ud } = await call("GET", "/api/universities");
  record(
    "universities list",
    us === 200 && Array.isArray(ud?.universities) && ud.universities.length > 0,
    `count=${ud?.universities?.length || 0}`
  );

  // 3. first upload
  const stamp = Date.now();
  const pdfBuf = buildTinyPdf(`Glass Library smoke test ${stamp}`);
  const type = await fileTypeFromBuffer(pdfBuf);
  record("upload buffer detected as PDF", type?.mime === "application/pdf", `mime=${type?.mime}`);

  const fd = new FormData();
  fd.append("file", new Blob([pdfBuf], { type: "application/pdf" }), `smoke-${stamp}.pdf`);
  fd.append("uploader_id", "smoke-test");
  const up1 = await call("POST", "/api/documents/upload", { body: fd });
  record(
    "first upload accepted",
    (up1.status === 201 || up1.status === 200) && !!up1.data?.document_id,
    `status=${up1.status} dedup=${up1.data?.deduplicated} doc=${up1.data?.document_id}`
  );

  // 4. dedup on re-upload
  const fd2 = new FormData();
  fd2.append("file", new Blob([pdfBuf], { type: "application/pdf" }), `smoke-${stamp}.pdf`);
  fd2.append("uploader_id", "smoke-test-2");
  const up2 = await call("POST", "/api/documents/upload", { body: fd2 });
  record(
    "second upload deduplicates",
    up2.status === 200 && up2.data?.deduplicated === true && up2.data?.document_id === up1.data?.document_id,
    `status=${up2.status} dedup=${up2.data?.deduplicated}`
  );

  // 4b. approve before search/download (default visibility is status=approved)
  if (up1.data?.document_id) {
    const mod = await call("PATCH", `/api/documents/${up1.data.document_id}/moderate`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    record(
      "moderation approves doc",
      mod.status === 200 && mod.data?.document?.status === "approved",
      `status=${mod.data?.document?.status}`
    );
  }

  // 5. search via title (LIKE path). Validates the search route end-to-end.
  //    Full FTS relevance ranking exercises the tsvector index; with synthetic
  //    PDFs (which pdf-parse@1.x can't fully parse), the LIKE fallback is what
  //    finds the doc by its title — both code paths are wired up.
  const sq = await call("GET", `/api/search?q=smoke&sort=recent`);
  const hits = sq.data?.results || [];
  const found = hits.find((h) => h.id === up1.data?.document_id);
  record(
    "search finds uploaded doc",
    sq.status === 200 && !!found,
    `count=${hits.length} found=${!!found}`
  );

  // 5b. document detail endpoint + view counter
  if (up1.data?.document_id) {
    const det = await call("GET", `/api/documents/${up1.data.document_id}`);
    record(
      "document detail endpoint",
      det.status === 200 && det.data?.document?.id === up1.data.document_id,
      `status=${det.status}`
    );
  }

  // 6. download (signed URL)
  if (up1.data?.document_id) {
    const dl = await call("GET", `/api/documents/${up1.data.document_id}/download`);
    record(
      "download returns signed URL",
      dl.status === 200 && /^https?:\/\//.test(dl.data?.url || ""),
      `status=${dl.status}`
    );
  } else {
    record("download returns signed URL", false, "no document_id from upload");
  }

  // 7. stats
  const st = await call("GET", "/api/stats/overview");
  record(
    "stats overview returns",
    st.status === 200 && typeof st.data?.documents?.total === "number",
    `total=${st.data?.documents?.total}`
  );

  // 8. invalid file rejection
  const bad = Buffer.from("not a real file, just text");
  const fdbad = new FormData();
  fdbad.append("file", new Blob([bad], { type: "application/octet-stream" }), "fake.bin");
  fdbad.append("uploader_id", "smoke-test");
  const badUp = await call("POST", "/api/documents/upload", { body: fdbad });
  record(
    "invalid file rejected",
    badUp.status === 400 && badUp.data?.code === "INVALID_FILE",
    `status=${badUp.status} code=${badUp.data?.code}`
  );

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke runner crashed:", e);
  process.exit(2);
});