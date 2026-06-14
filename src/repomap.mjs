// repomap.mjs — a zero-dependency repo SYMBOL INDEX (Invention Block 3).
//
// Top coding agents (Cursor) lean on a semantic/vector index to locate code; slivr only had grep,
// which returns every mention of a name (definition AND all call sites) and makes the model read
// through the noise. This builds a precise symbol index by a fast, two-pass, regex-driven scan —
// no vector DB, no embeddings, no dependencies — so the agent can JUMP to a definition.
//
// Two-tier (per the winning idea): repoOverview() is the shallow global map (files + their top-level
// symbols); findSymbol() is the on-demand detail (exact definition file:line + signature).

import fs from "node:fs";
import path from "node:path";

// Directories never worth indexing.
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".cache",
  "vendor", "target", "__pycache__", ".venv", "venv", ".idea", ".gradle", "bin",
]);

// ext -> language key
const LANG_BY_EXT = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js",
  ".py": "py", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "rb",
  ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".hpp": "c",
};

// JS keywords that the "method-like" pattern (NAME(...) {) must NOT capture as a symbol.
const JS_KW = new Set(["if", "for", "while", "switch", "catch", "return", "function", "do", "else", "with", "case"]);

// Per-language line patterns: [regex capturing the symbol NAME, kind].
const PATTERNS = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    // Top-level (column-0) bindings only — so indented LOCAL vars inside functions aren't indexed.
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "function"],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "const"],
    [/^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, "method"],
  ],
  py: [
    [/^\s*def\s+([A-Za-z_]\w*)/, "function"],
    [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, "type"],
  ],
  rust: [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, "type"],
  ],
  java: [
    [/^\s*(?:public|private|protected|final|abstract|\s)*class\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*(?:public|private|protected)[\w\s<>\[\],.]*\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/, "method"],
  ],
  rb: [
    [/^\s*def\s+([A-Za-z_]\w*[!?]?)/, "function"],
    [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
  ],
  c: [
    [/^[A-Za-z_][\w\s\*]*\s+\**([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/, "function"],
  ],
};

// Extract { name, kind, line, signature } symbols from one file's text for the given language.
export function extractSymbols(text, lang) {
  const pats = PATTERNS[lang];
  if (!pats) return [];
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.length > 400) continue;
    for (const [re, kind] of pats) {
      const m = line.match(re);
      if (m && m[1]) {
        if (lang === "js" && kind === "method" && JS_KW.has(m[1])) break; // not a real method
        out.push({ name: m[1], kind, line: i + 1, signature: line.trim().slice(0, 120) });
        break; // one symbol per line
      }
    }
  }
  return out;
}

function* walk(dir, root, { maxFiles }) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") { /* hidden */ }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && LANG_BY_EXT[path.extname(e.name)]) {
        if (++count > maxFiles) return;
        yield full;
      }
    }
  }
}

// Build the index over `workdir`. Returns { files, symbols, byName, root }.
//   symbols: [{ name, kind, file (relative), line, signature }]
//   byName:  Map<name, symbol[]>
export function buildSymbolIndex(workdir, { maxFiles = 5000, maxBytes = 600_000 } = {}) {
  const root = path.resolve(workdir);
  const symbols = [];
  const files = [];
  const allFiles = [];
  for (const abs of walk(root, root, { maxFiles })) {
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > maxBytes) continue;
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const rel = path.relative(root, abs);
    allFiles.push(rel);
    const lang = LANG_BY_EXT[path.extname(abs)];
    const syms = extractSymbols(text, lang).map(s => ({ ...s, file: rel }));
    if (syms.length) files.push({ file: rel, count: syms.length });
    for (const s of syms) symbols.push(s);
  }
  const byName = new Map();
  for (const s of symbols) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  return { root, files, symbols, byName, allFiles };
}

export function langOf(file) { return LANG_BY_EXT[path.extname(file)] || null; }

const BRACE_LANGS = new Set(["js", "go", "rust", "java", "c"]);

// Mask string literals + // line comments on a line so braces inside them aren't counted.
function maskLine(line) {
  return line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

// SAFE span detection (Block 7): given a definition's start line, return the {start,end} (0-based,
// inclusive) line range of its full body — by brace-matching (JS/Go/Rust/Java/C) or indent (Python).
// Returns null when uncertain (no body braces, unbalanced, one-liner) so callers fall back to edit_file
// rather than risk a wrong-span edit. CORRECTNESS-FIRST, in the spirit of SEAL.
export function symbolSpan(text, lang, defLine1) {
  const lines = text.split("\n");
  const i0 = defLine1 - 1;
  if (i0 < 0 || i0 >= lines.length) return null;
  if (lang === "py") {
    const indent = (lines[i0].match(/^[ \t]*/) || [""])[0].length;
    let end = i0;
    for (let i = i0 + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;                                   // blanks may be inside the body
      const ind = (lines[i].match(/^[ \t]*/) || [""])[0].length;
      if (ind <= indent) break;                                         // dedent → body ended
      end = i;
    }
    return end > i0 ? { start: i0, end } : null;                        // require a real (indented) body
  }
  if (BRACE_LANGS.has(lang)) {
    let depth = 0, started = false, end = -1;
    const limit = Math.min(lines.length, i0 + 4000);
    for (let i = i0; i < limit; i++) {
      for (const ch of maskLine(lines[i])) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") { depth--; if (started && depth === 0) { end = i; break; } }
      }
      if (end !== -1) break;
      if (!started && i - i0 > 3) return null;                          // no body brace nearby → bail
    }
    return (started && end !== -1) ? { start: i0, end } : null;
  }
  return null;
}

// On-demand detail: exact definition location(s) for a name. Falls back to case-insensitive and then
// substring matching so a slightly-wrong name from the model still resolves (cheap fuzzy recovery).
export function findSymbol(index, name) {
  if (!index || !name) return [];
  if (index.byName.has(name)) return index.byName.get(name);
  const lower = String(name).toLowerCase();
  const ci = index.symbols.filter(s => s.name.toLowerCase() === lower);
  if (ci.length) return ci;
  return index.symbols.filter(s => s.name.toLowerCase().includes(lower)).slice(0, 25);
}

// TIER-2 (Block 6): on-demand call-site / reference locator. Where is `name` USED (not defined)?
// Scans source for word-boundary identifier matches (so "run" doesn't match "rerun"/"running"),
// strips `//` line comments to cut commented-out noise, and EXCLUDES the symbol's own definition
// lines. Each hit is tagged isCall when it's `name(` (an actual invocation). This is what you need
// before changing a signature — find every caller. Far more precise than a substring grep.
export function findReferences(index, name, { max = 200 } = {}) {
  if (!index || !name || !index.allFiles) return [];
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = new RegExp(`\\b${esc}\\b`);
  const callRe = new RegExp(`\\b${esc}\\s*\\(`);
  const defLines = new Set((index.byName.get(name) || []).map(s => `${s.file}:${s.line}`));
  const out = [];
  for (const rel of index.allFiles) {
    let text;
    try { text = fs.readFileSync(path.join(index.root, rel), "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const code = raw.replace(/\/\/.*$/, "");   // drop trailing // comment for matching
      if (!wordRe.test(code)) continue;
      if (defLines.has(`${rel}:${i + 1}`)) continue;   // this line IS the definition, not a use
      out.push({ file: rel, line: i + 1, isCall: callRe.test(code), text: raw.trim().slice(0, 160) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

// Shallow global map: each file with its top symbols, compact and token-cheap.
export function repoOverview(index, { maxFiles = 60, perFile = 12 } = {}) {
  if (!index || !index.files.length) return "(no indexable source files found)";
  const lines = [`${index.symbols.length} symbols across ${index.files.length} files:`];
  const files = [...index.files].sort((a, b) => b.count - a.count).slice(0, maxFiles);
  for (const f of files) {
    const top = index.symbols.filter(s => s.file === f.file).slice(0, perFile).map(s => s.name);
    lines.push(`  ${f.file}: ${top.join(", ")}${f.count > perFile ? ` … (+${f.count - perFile})` : ""}`);
  }
  return lines.join("\n");
}
