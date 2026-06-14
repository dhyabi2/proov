#!/usr/bin/env node
// stub-mcp.mjs — a TINY local MCP server for deterministic tests. No network, no deps.
//
// Speaks JSON-RPC 2.0 over stdio as NEWLINE-DELIMITED JSON (one object per line), the same wire
// format src/mcp.mjs expects. Implements:
//   initialize            -> protocol handshake
//   notifications/initialized (notification, no reply)
//   tools/list            -> two tools: echo(text), add(a,b)
//   tools/call            -> runs echo/add, returns content:[{type:'text',text}]
// Anything else returns a JSON-RPC method-not-found error.

import readline from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) require no response.
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-mcp", version: "0.0.1" },
      });
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === "echo") {
        return reply(id, { content: [{ type: "text", text: String(args.text ?? "") }] });
      }
      if (name === "add") {
        const sum = Number(args.a) + Number(args.b);
        return reply(id, { content: [{ type: "text", text: String(sum) }] });
      }
      return reply(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  try { handle(msg); } catch (e) { if (msg?.id !== undefined) fail(msg.id, -32603, String(e.message || e)); }
});
