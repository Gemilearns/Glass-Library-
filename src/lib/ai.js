// src/lib/ai.js — Gemini integration with ENABLE_AI gate + simple rate queue
// See Part 4 of the build spec. NEVER let Gemini be the sole gate for auto-approval.
import { GoogleGenerativeAI } from "@google/generative-ai";
import cfg from "../config.js";

let _model = null;
function model() {
  if (_model) return _model;
  if (!cfg.GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(cfg.GEMINI_API_KEY);
  _model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  return _model;
}

// Simple token-bucket-ish rate limiter: max N requests per 60s window.
// Free-tier safe default = 15 RPM. We just delay, not drop.
const queue = [];
let windowStart = Date.now();
let used = 0;

async function takeSlot() {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    used = 0;
  }
  if (used >= cfg.AI_RPM) {
    const wait = 60_000 - (now - windowStart) + 50;
    await new Promise((r) => setTimeout(r, wait));
    windowStart = Date.now();
    used = 0;
  }
  used += 1;
}

const PROMPT = `
You are classifying an academic document for a university library system.
Filename: {FILENAME}
Content excerpt: {EXCERPT}

Respond ONLY in valid JSON, no markdown fences, no preamble:
{
  "doc_type": "past_paper" | "notes" | "textbook" | "thesis" | "assignment" | "other",
  "unit_code_guess": "string or null",
  "summary": "2-3 sentence summary of the content",
  "suggested_tags": ["tag1", "tag2", "tag3"],
  "confidence": 0.0 to 1.0
}
`.trim();

/**
 * Classify + summarize via Gemini. Returns null if AI is disabled or fails.
 * Callers MUST handle null gracefully and fall back to regex-only signals.
 */
export async function classifyAndSummarize(extractedText, filename) {
  if (!cfg.ENABLE_AI) return null;
  const m = model();
  if (!m) return null;

  try {
    await takeSlot();
    const prompt = PROMPT
      .replace("{FILENAME}", filename || "(no name)")
      .replace("{EXCERPT}", (extractedText || "").slice(0, 2000));
    const result = await m.generateContent(prompt);
    const text = (result.response.text() || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);

    // Defensive normalization
    const allowedTypes = new Set(["past_paper", "notes", "textbook", "thesis", "assignment", "other"]);
    return {
      doc_type: allowedTypes.has(parsed.doc_type) ? parsed.doc_type : "other",
      unit_code_guess: typeof parsed.unit_code_guess === "string" ? parsed.unit_code_guess : null,
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 600) : "",
      suggested_tags: Array.isArray(parsed.suggested_tags)
        ? parsed.suggested_tags.slice(0, 5).map(String).map((s) => s.toLowerCase().trim()).filter(Boolean)
        : [],
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    };
  } catch (err) {
    console.warn("[ai] classifyAndSummarize failed (falling back):", err?.message || err);
    return null;
  }
}

/**
 * True if the AI module is configured and ready.
 */
export function aiEnabled() {
  return cfg.ENABLE_AI && !!cfg.GEMINI_API_KEY;
}