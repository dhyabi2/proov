// debug.mjs — default-ON debug log (Block 90). Appends a JSONL trace of everything useful for diagnosing a run
// — RAW provider requests & responses (with the API key REDACTED), tool calls + results, gate decisions, and
// errors — to a single file. A configurable singleton: the CLI entry calls configureDebug() once at startup;
// every module then imports debugLog() and writes without threading a logger through constructors. It is OFF by
// default at the module level (so library/test use never writes); the CLI turns it ON (config.debug, default
// true). debugLog NEVER throws — a logging failure must never break a run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = { enabled: false, file: "", started: false };

// The default location: the home .proov dir (already used for the journal/skills) — one discoverable file.
export function defaultDebugFile() { return path.join(os.homedir(), ".proov", "debug.log"); }

// Enable/locate the log. enabled defaults to true (the CLI passes config.debug); file "" → defaultDebugFile().
export function configureDebug({ enabled = true, file = "" } = {}) {
  STATE.enabled = enabled !== false;
  STATE.file = file || defaultDebugFile();
  STATE.started = false;
  return STATE.file;
}
export function debugEnabled() { return !!STATE.enabled; }
export function debugFilePath() { return STATE.file; }

// Redact secrets from anything we serialize: Authorization headers, api-key fields, and OpenRouter "sk-or-…"
// tokens wherever they appear. Used as a JSON.stringify replacer so it's a SINGLE pass (no double-serialize of
// the big request bodies). The raw messages/response bodies are kept in full — that's the point of the log.
function secretReplacer(key, value) {
  if (typeof key === "string" && /^(authorization|api[_-]?key|key|x-api-key|apiKey)$/i.test(key)) return "***REDACTED***";
  if (typeof value === "string") {
    let v = value;
    if (/^Bearer\s+\S+/i.test(v)) v = "Bearer ***REDACTED***";
    v = v.replace(/sk-or-[A-Za-z0-9._-]{6,}/g, "sk-or-***REDACTED***");
    return v;
  }
  return value;
}

function ensureStarted() {
  if (STATE.started) return;
  fs.mkdirSync(path.dirname(STATE.file), { recursive: true });
  fs.appendFileSync(STATE.file, `\n# ===== proov run @ ${new Date().toISOString()} · pid ${process.pid} · ${process.cwd()} =====\n`);
  STATE.started = true;
}

// Append one event. `event` is a short tag (e.g. "request", "response", "tool_call"); `data` is any JSON value.
export function debugLog(event, data = {}) {
  if (!STATE.enabled || !STATE.file) return;
  try {
    ensureStarted();
    fs.appendFileSync(STATE.file, JSON.stringify({ ts: new Date().toISOString(), event, ...data }, secretReplacer) + "\n");
  } catch { /* logging must NEVER break a run */ }
}

// The directory beside the log that holds the linked body files (e.g. ~/.proov/debug.log → ~/.proov/debug-bodies/).
export function bodiesDir() { return path.join(path.dirname(STATE.file), path.basename(STATE.file).replace(/\.[^.]*$/, "") + "-bodies"); }

let _seq = 0;
// A run-unique id: pid keeps it distinct across concurrent proov processes; a counter orders within the run.
export function nextDebugId() { _seq += 1; return `${process.pid}-${String(_seq).padStart(6, "0")}`; }

// LINK a heavy body (a raw request / response) to its OWN file and write a COMPACT index line to debug.log that
// points at it by id (Block 90). Keeps debug.log small + greppable while the full bytes stay addressable (and
// prunable) on disk. Returns the id (or null when disabled / on error). `summary` is the small inline metadata.
export function debugBody(event, summary = {}, body = undefined) {
  if (!STATE.enabled || !STATE.file) return null;
  try {
    ensureStarted();
    const id = nextDebugId();
    const dir = bodiesDir();
    fs.mkdirSync(dir, { recursive: true });
    const bodyPath = path.join(dir, `${id}.json`);
    fs.writeFileSync(bodyPath, JSON.stringify(body, secretReplacer, 2));
    fs.appendFileSync(STATE.file, JSON.stringify({ ts: new Date().toISOString(), event, id, body: path.relative(path.dirname(STATE.file), bodyPath), ...summary }, secretReplacer) + "\n");
    return id;
  } catch { return null; }
}
