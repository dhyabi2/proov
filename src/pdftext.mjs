// pdftext.mjs — LOCAL pdf text extraction fallback (poppler `pdftotext` or `mutool`).
//
// The primary path for view_pdf is OpenRouter's multimodal file-parser plugin (see multimodal.mjs).
// This is the FALLBACK used when (a) the extractor binary is on PATH and the caller asks for it, or
// (b) the model can't ingest the file block. It shells out to whichever tool is available and
// classifies the result: real text, vs. "no extractable text" (scanned/image-only PDF → OCR needed,
// which we do NOT support). Kept separate from tools.mjs so the classification is unit-testable
// without spawning a real binary (the runner is injectable).

import { execFileSync } from "node:child_process";

// Is a binary resolvable on PATH? Uses `command -v` via a tiny which-like probe. Injectable for tests.
export function whichPdfTool(run = defaultRun) {
  for (const tool of ["pdftotext", "mutool"]) {
    try { run(tool === "pdftotext" ? "pdftotext" : "mutool", ["-v"]); return tool; }
    catch { /* not present / errored — try next */ }
  }
  return null;
}

// Classify extractor OUTPUT into a stable shape. PURE — no FS, no spawn. Exported for tests.
//   ok:true  + text  when there's real extractable text
//   ok:false + reason "SCANNED" when the PDF parsed but yielded (almost) no text (likely scanned)
//   ok:false + reason "EMPTY"   when output was blank
export function classifyPdfText(raw, { max = 12000 } = {}) {
  const text = String(raw == null ? "" : raw).replace(/\f/g, "\n").trim();
  // strip whitespace-only to decide "has real characters"
  const meaningful = text.replace(/\s+/g, "");
  if (meaningful.length === 0) {
    return { ok: false, reason: "EMPTY", note: "no extractable text — likely a scanned PDF; OCR not supported" };
  }
  if (meaningful.length < 8) {
    return { ok: false, reason: "SCANNED", note: "almost no extractable text — likely a scanned/image PDF; OCR not supported" };
  }
  const clipped = text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text;
  return { ok: true, text: clipped, chars: text.length };
}

// Extract text from a real PDF file on disk via a local binary. Returns the classifyPdfText shape,
// or { ok:false, reason:"NO_TOOL" } when neither extractor is installed, or { ok:false, reason:"EXEC" }
// when the binary failed. `run` is injectable so tests don't spawn anything.
export function localPdfText(absPath, { run = defaultRun, which = whichPdfTool, max = 12000 } = {}) {
  const tool = which(run);
  if (!tool) return { ok: false, reason: "NO_TOOL", note: "no local PDF extractor (install poppler's pdftotext or mutool) and the OpenRouter parser was unavailable" };
  let raw;
  try {
    if (tool === "pdftotext") raw = run("pdftotext", ["-q", "-layout", absPath, "-"]);
    else raw = run("mutool", ["draw", "-F", "txt", absPath]); // mutool text extraction
  } catch (e) {
    return { ok: false, reason: "EXEC", note: `local extractor (${tool}) failed: ${String(e && e.message || e).slice(0, 200)}` };
  }
  const r = classifyPdfText(raw, { max });
  return { ...r, tool };
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
}
