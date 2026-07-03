// src/lib/classify.js — regex-based classification used BEFORE AI.
// Cheap, deterministic, works offline. AI may override or raise confidence.

const DOC_TYPE_PATTERNS = [
  { type: "past_paper", re: /(past\s*paper|examination|final\s*exam|cat\s*\d|continuous\s*assessment)/i },
  { type: "notes", re: /(lecture\s*notes|notes|summary|handout|chapter\s*\d)/i },
  { type: "textbook", re: /(textbook|handbook|manual|guidebook)/i },
  { type: "thesis", re: /(thesis|dissertation|research\s*project)/i },
  { type: "assignment", re: /(assignment|coursework|take[-\s]?home|tutorial\s*\d)/i },
];

// Captures common unit-code formats: ABC 123, ABC123, ABC-123, ABC1234
const UNIT_CODE_RE = /\b([A-Z]{2,6})[\s-]?(\d{3,4})\b/g;

/**
 * Classify via filename + first chunk of extracted text.
 * Returns { docType, unitCodeGuess, signals }
 */
export function regexClassify(filename, text) {
  const blob = `${filename || ""}\n${(text || "").slice(0, 1500)}`;

  let docType = "other";
  for (const p of DOC_TYPE_PATTERNS) {
    if (p.re.test(blob)) {
      docType = p.type;
      break;
    }
  }

  const codes = new Set();
  let m;
  while ((m = UNIT_CODE_RE.exec(blob)) !== null) {
    codes.add(`${m[1]} ${m[2]}`);
  }
  const unitCodeGuess = codes.size === 1 ? [...codes][0] : null;

  return { docType, unitCodeGuess };
}

/**
 * Merge regex signal with AI signal. Per spec:
 * - both agree     → confidence ≥ 0.9, status = approved
 * - partial        → 0.5–0.8, status = pending
 * - disagreement   → < 0.5, status = pending
 *
 * AI is optional. When absent we degrade gracefully.
 */
export function mergeClassificationSignals(regex, ai) {
  // No AI → regex-only path. Lower the bar to flag, status stays pending.
  if (!ai) {
    const conf = 0.45; // middling: needs human review
    return {
      docType: regex.docType,
      unitCodeGuess: regex.unitCodeGuess,
      confidence: conf,
      status: "pending",
      summary: null,
      tags: [],
    };
  }

  const docTypeAgrees = ai.doc_type === regex.docType;
  const unitAgrees =
    (ai.unit_code_guess && regex.unitCodeGuess &&
      ai.unit_code_guess.toUpperCase() === regex.unitCodeGuess.toUpperCase()) ||
    // AI "guessed a code" but regex didn't find one (or vice versa) — treat as partial
    (!ai.unit_code_guess && !regex.unitCodeGuess);

  let confidence;
  let status;
  if (docTypeAgrees && unitAgrees) {
    confidence = Math.max(0.9, ai.confidence || 0.9);
    status = "approved";
  } else if (docTypeAgrees || unitAgrees) {
    confidence = Math.max(0.5, Math.min(0.8, ai.confidence || 0.6));
    status = "pending";
  } else {
    confidence = Math.min(0.49, ai.confidence || 0.3);
    status = "pending";
  }

  return {
    docType: ai.doc_type || regex.docType,
    unitCodeGuess: ai.unit_code_guess || regex.unitCodeGuess,
    confidence,
    status,
    summary: ai.summary || null,
    tags: ai.suggested_tags || [],
  };
}