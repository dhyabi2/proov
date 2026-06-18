#!/usr/bin/env node
// monitor/server.mjs — a tiny ZERO-DEP app that SUBSCRIBES to proov's workflow events and shows, in real
// time, where the agent currently is in the workflow (highlighted on the BPMN diagram).
//
//   node monitor/server.mjs            # → http://localhost:8899
//   then run proov with the sink pointed here:
//     PROOV_EVENTS_URL=http://localhost:8899/ingest  proov "build a tetris game"
//   (or set "eventsUrl":"http://localhost:8899/ingest" in ~/.proov.json)
//
// Endpoints: POST /ingest (proov posts each event) · GET /events (SSE stream, with replay) ·
//            GET /workflow.bpmn (the v2 diagram) · GET / (the live UI).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8899;
const PUBLIC = path.join(__dirname, "public");
const BPMN = path.resolve(__dirname, "..", "docs", "proov-workflow-v2.bpmn");
const MAX = 1000;

const clients = new Set();   // open SSE responses
const recent = [];           // ring buffer for replay to late subscribers

const sse = (res, evt) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* */ } };
const broadcast = (evt) => { for (const res of clients) sse(res, evt); };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".bpmn": "application/xml", ".svg": "image/svg+xml" };
function serveFile(res, f, ct) {
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end("not found"); }
    else { res.writeHead(200, { "content-type": ct || MIME[path.extname(f)] || "text/plain", "access-control-allow-origin": "*" }); res.end(b); }
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/ingest") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { const evt = JSON.parse(body); evt._recv = Date.now(); recent.push(evt); if (recent.length > MAX) recent.shift(); broadcast(evt); } catch { /* ignore bad event */ }
      res.writeHead(204, { "access-control-allow-origin": "*" }); res.end();
    });
    return;
  }
  if (u.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    res.write("retry: 2000\n\n");
    for (const e of recent) sse(res, e);   // replay history so a new tab catches up
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (u.pathname === "/runs") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([...new Set(recent.map((e) => e.runId))])); return; }
  if (u.pathname === "/reset") { recent.length = 0; res.writeHead(204); res.end(); return; }
  if (u.pathname === "/workflow.bpmn") { serveFile(res, BPMN, "application/xml"); return; }
  if (u.pathname === "/" || u.pathname === "/index.html") { serveFile(res, path.join(PUBLIC, "index.html")); return; }
  const f = path.join(PUBLIC, u.pathname.replace(/^\/+/, ""));
  if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) { serveFile(res, f); return; }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log(`proov monitor → http://localhost:${PORT}\n  point proov at it:  PROOV_EVENTS_URL=http://localhost:${PORT}/ingest  proov "<task>"`));
