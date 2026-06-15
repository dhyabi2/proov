// style.mjs — detect a repo's HOUSE STYLE so the agent edits/adds code in the existing conventions
// instead of its own default (Block 14). CONFIG-FIRST (authoritative): .editorconfig, prettier; then
// HEURISTIC: sample existing source files and count indent / quotes / semicolons / naming. Zero LLM,
// zero dependencies. A compact brief is injected into the agent's context so new code matches.

import fs from "node:fs";
import path from "node:path";
import { extractSymbols, langOf } from "./repomap.mjs";

const SKIP = new Set([".git", "node_modules", "dist", "build", "out", "vendor", "target", "__pycache__", ".venv", "venv"]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".rb", ".c", ".h", ".cc", ".cpp"]);

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }

// Collect up to `max` source files (shallow-ish walk, skipping junk dirs).
function sampleFiles(dir, max) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < max) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= max) break;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(full); }
      else if (CODE_EXT.has(path.extname(e.name))) out.push(full);
    }
  }
  return out;
}

// Parse the nearest .editorconfig for indent_style/size (root section, best-effort).
function fromEditorConfig(dir) {
  const txt = read(path.join(dir, ".editorconfig"));
  if (!txt) return null;
  const style = (txt.match(/indent_style\s*=\s*(tab|space)/i) || [])[1];
  const size = parseInt((txt.match(/indent_size\s*=\s*(\d+)/i) || [])[1], 10);
  if (!style && !size) return null;
  return { indentStyle: style ? style.toLowerCase() : null, indentSize: Number.isFinite(size) ? size : null };
}

// Parse prettier config (file or package.json "prettier") for the obvious style keys.
function fromPrettier(dir) {
  let cfg = null;
  for (const f of [".prettierrc", ".prettierrc.json", ".prettierrc.js"]) { const t = read(path.join(dir, f)); if (t) { try { cfg = JSON.parse(t); break; } catch { /* js config — skip */ } } }
  if (!cfg) { try { cfg = JSON.parse(read(path.join(dir, "package.json")) || "{}").prettier || null; } catch { /* */ } }
  if (!cfg || typeof cfg !== "object") return null;
  return {
    indentStyle: cfg.useTabs === true ? "tab" : cfg.useTabs === false ? "space" : null,
    indentSize: Number.isFinite(cfg.tabWidth) ? cfg.tabWidth : null,
    quote: cfg.singleQuote === true ? "single" : cfg.singleQuote === false ? "double" : null,
    semi: cfg.semi === true ? true : cfg.semi === false ? false : null,
  };
}

function majority(a, b, va, vb) { const t = a + b; if (!t) return null; return { value: a >= b ? va : vb, confidence: Math.max(a, b) / t }; }

// Detect the repo's house style. Returns { indent, quote, semi, naming, basis } (each field may be null).
export function detectStyle(dir, { sample = 50 } = {}) {
  const ec = fromEditorConfig(dir) || {};
  const pr = fromPrettier(dir) || {};
  const files = sampleFiles(dir, sample);

  let tabs = 0, spaces = 0, two = 0, four = 0, single = 0, dbl = 0, semiYes = 0, semiNo = 0, camel = 0, snake = 0;
  for (const f of files) {
    const text = read(f); if (!text) continue;
    const lang = langOf(f);
    for (const line of text.split("\n")) {
      const m = line.match(/^([ \t]+)\S/); if (!m) continue;
      if (m[1][0] === "\t") tabs++;
      else { spaces++; const n = m[1].length; if (n === 2) two++; else if (n === 4) four++; }
    }
    single += (text.match(/'(?:[^'\\]|\\.)*'/g) || []).length;
    dbl += (text.match(/"(?:[^"\\]|\\.)*"/g) || []).length;
    if (lang === "js") for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (t.endsWith(";")) semiYes++;                         // a terminated statement
      else if (/[\w)\]'"`]$/.test(t)) semiNo++;               // ends with a value but NO semicolon → no-semi style
    }
    for (const s of extractSymbols(text, lang)) { if (/_/.test(s.name)) snake++; else if (/[a-z][A-Z]/.test(s.name)) camel++; }
  }

  // indent: config wins, else heuristic
  let indent = null;
  const istyle = ec.indentStyle || pr.indentStyle || (tabs + spaces ? (tabs > spaces ? "tab" : "space") : null);
  const isize = ec.indentSize || pr.indentSize || (two + four ? (two >= four ? 2 : 4) : null);
  if (istyle) indent = { style: istyle, size: istyle === "tab" ? null : isize };

  const quote = pr.quote ? { value: pr.quote, confidence: 1 } : majority(single, dbl, "single", "double");
  const semi = pr.semi !== null && pr.semi !== undefined ? { value: pr.semi, confidence: 1 } : majority(semiYes, semiNo, true, false);
  const naming = majority(camel, snake, "camel", "snake");
  const basis = (ec.indentStyle || ec.indentSize || pr.indentStyle || pr.quote != null) ? "config+heuristic" : (files.length ? "heuristic" : "none");

  return { indent, quote, semi, naming, basis, filesSampled: files.length };
}

// A compact one-line "house style" brief for the agent (empty when nothing confident is known).
export function styleBrief(s) {
  if (!s) return "";
  const parts = [];
  if (s.indent) parts.push(s.indent.style === "tab" ? "tab indent" : `${s.indent.size || 2}-space indent`);
  if (s.quote && s.quote.confidence >= 0.6) parts.push(`${s.quote.value} quotes`);
  if (s.semi && s.semi.confidence >= 0.6) parts.push(s.semi.value ? "semicolons" : "no semicolons");
  if (s.naming && s.naming.confidence >= 0.6) parts.push(s.naming.value === "snake" ? "snake_case names" : "camelCase names");
  return parts.length ? parts.join(" · ") : "";
}
