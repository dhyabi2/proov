#!/usr/bin/env node
// cc-alt — a configurable-LLM coding agent CLI.
//
//   cc-alt                      open an interactive REPL in the current repo
//   cc-alt "<task>" [dir]       run one task non-interactively (one-shot)
//   cc-alt config               print the resolved configuration
//   cc-alt --init               write a starter ./.cc-alt.json
//   cc-alt --help / --version
//
// Flags (override config): --model <id>, --approval <auto|edits|all>, --auto, --dir <path>,
//                          --baseline (compat: run the full-rewrite harness one-shot).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, writeStarterConfig } from "../src/config.mjs";
import { Session, planGate } from "../src/agent.mjs";
import { runBaseline } from "../src/baseline.mjs";
import { startRepl } from "../src/repl.mjs";
import { makePalette, colorEnabled, stepLine, footer, renderPlan, renderTasks, planPrompt, readPlanEdit } from "../src/ui.mjs";
import { renderDiff, diffStat } from "../src/diff.mjs";
import { isDestructive, needsApproval } from "../src/safety.mjs";
import { connectAll, closeAll } from "../src/mcp.mjs";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
    return pkg.version;
  } catch { return "0.0.0"; }
})();

// ---- tiny flag parser -------------------------------------------------------
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let baseline = false, init = false, help = false, version = false, auto = false, plan = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-v") version = true;
    else if (a === "--init") init = true;
    else if (a === "--baseline") baseline = true;
    else if (a === "--plan") plan = true;
    else if (a === "--auto") { auto = true; flags.approval = "auto"; }
    else if (a === "--model") flags.model = argv[++i];
    else if (a === "--approval") flags.approval = argv[++i];
    else if (a === "--dir") flags.dir = argv[++i];
    else if (a === "--max-steps") flags.maxSteps = Number(argv[++i]);
    else if (a.startsWith("--model=")) flags.model = a.slice(8);
    else if (a.startsWith("--approval=")) flags.approval = a.slice(11);
    else if (a.startsWith("--dir=")) flags.dir = a.slice(6);
    else if (a.startsWith("--")) { /* ignore unknown flags */ }
    else positional.push(a);
  }
  return { flags, positional, baseline, init, help, version, auto, plan };
}

const HELP = `cc-alt — configurable-LLM coding agent (any Claude/GPT/Gemini model via OpenRouter)

USAGE
  cc-alt                       open an interactive REPL in the current directory
  cc-alt "<task>" [dir]        run one task non-interactively (one-shot)
  cc-alt config                print the resolved configuration (and where each value came from)
  cc-alt --init                write a starter ./.cc-alt.json

OPTIONS
  --model <id>                 model id (e.g. anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-flash)
  --approval <auto|edits|all>  when to ask before acting (default: edits)
  --auto                       shorthand for --approval auto (no prompts; destructive cmds still blocked)
  --plan                       plan-mode: agent must produce + get approval for a numbered plan before editing
  --dir <path>                 working directory (default: cwd or the 2nd positional arg)
  --max-steps <n>              cap tool-calls per turn
  --baseline                   one-shot using the full-rewrite harness (for the cost benchmark)
  -h, --help                   show this help
  -v, --version                show version

CONFIG  (precedence: flags > ./.cc-alt.json > ~/.cc-alt.json > env > defaults)
  keys: model, apiKey, baseUrl, approval, maxSteps, maxTokensPerTurn
  key:  set OPENROUTER_API_KEY in the environment (preferred) or apiKey in .cc-alt.json

EXAMPLES
  cc-alt                                              # REPL, default model
  cc-alt "add input validation to src/calc.js"        # one-shot in cwd
  cc-alt "fix the failing test" ./myrepo --auto       # one-shot, no prompts
  cc-alt --model anthropic/claude-sonnet-4            # REPL on Claude
  cc-alt config                                       # show resolved config`;

// ---- one-shot ---------------------------------------------------------------
async function runOneShot(task, dir, config, palette, { auto, plan }) {
  const p = palette;
  const session = new Session(dir, {
    model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
    maxSteps: config.maxSteps, maxTokensPerTurn: config.maxTokensPerTurn,
    planMode: !!plan,
  });
  if (!session.provider.hasKey()) {
    process.stderr.write(p.yellow("warning: no API key (set OPENROUTER_API_KEY or apiKey in .cc-alt.json)\n"));
  }
  // Connect any configured MCP servers; their tools become callable as mcp__<server>__<tool>.
  if (config.mcpServers) {
    const { catalog, errors } = await session.connectMCP(config.mcpServers);
    if (catalog.length) process.stderr.write(p.dim(`mcp · ${catalog.length} tool(s) from ${session.mcpClients.length} server(s)\n`));
    for (const e of errors) process.stderr.write(p.yellow(`mcp · ${e.server} failed: ${e.error}\n`));
  }
  const approval = auto ? "auto" : config.approval;
  process.stderr.write(p.dim(`cc-alt · model ${config.model} · ${path.resolve(dir)}${plan ? " · plan-mode" : ""}\n`));

  // Plan-approval: when a plan exists but isn't approved yet, approve it (auto/non-TTY -> auto-approve
  // but still SHOW it; interactive -> y/e/n). Edit lets the user replace the steps.
  const approvePlan = async () => {
    const pl = session.tools.plan;
    if (!pl || pl.approved) return;
    process.stderr.write("\n" + renderPlan(pl, p) + "\n");
    if (auto || !process.stdin.isTTY) { pl.approved = true; process.stderr.write(p.dim("  (auto-approved)\n")); return; }
    const verdict = await planPrompt("proceed?");
    if (verdict === "yes") { pl.approved = true; }
    else if (verdict === "edit") {
      const steps = await readPlanEdit();
      if (steps.length) { session.tools.plan = { steps, approved: true }; process.stderr.write(renderPlan(session.tools.plan, p) + "\n"); }
      else pl.approved = true;
    } else { session.tools._planAborted = true; }
  };

  const beforeTool = async ({ tool, args }) => {
    if (tool === "run_command") {
      const v = isDestructive(args.command || "");
      if (v.blocked) {
        process.stderr.write(p.red(`  ⛔ blocked: ${args.command} (${v.why})\n`));
        return { deny: true, reason: `refused — ${v.why}` };
      }
    }
    // plan-mode gate: block mutating tools until a plan is recorded + approved.
    if (plan) {
      await approvePlan();
      if (session.tools._planAborted) return { deny: true, reason: "user aborted the plan; stop and call done." };
      const g = planGate({ tool, tools: session.tools });
      if (g.deny) { process.stderr.write(p.yellow(`  ∅ ${tool} blocked — ${g.reason}\n`)); return g; }
    }
    if (approval !== "auto" && needsApproval(tool, approval) && !process.stdin.isTTY) {
      process.stderr.write(p.yellow(`  ∅ skipped ${tool} (needs approval; re-run with --auto to allow)\n`));
      return { deny: true, reason: "approval required but session is non-interactive; user must pass --auto" };
    }
    return { deny: false };
  };

  let lastTasksRender = "";
  const onStep = ({ tool, args, result, denied }) => {
    if (tool === "done") return;
    const status = denied ? "skip" : result?.ok === false ? "fail" : "ok";
    let extra = "";
    if ((tool === "edit_file" || tool === "create_file") && result?.ok && session.lastDiff) {
      const s = diffStat(session.lastDiff.before, session.lastDiff.after);
      extra = `+${s.add} -${s.del}` + (result.tier ? ` (${result.tier})` : "");
    } else if (tool === "run_command") extra = result?.ok ? "exit 0" : `exit ${result?.exitCode ?? "?"}`;
    else if (tool === "parallel") extra = result?.ok ? `${result.count} subtasks @${result.cap}` : (result?.error || "");
    else if (tool === "plan") extra = result?.ok ? `${result.steps?.length || 0} steps` : "";
    process.stderr.write(stepLine({ tool, args, status, extra, palette: p }) + "\n");
    if ((tool === "edit_file" || tool === "create_file") && result?.ok && session.lastDiff) {
      const d = renderDiff(session.lastDiff.before, session.lastDiff.after, { color: p.enabled, path: session.lastDiff.path });
      if (d) process.stderr.write(d.split("\n").map(l => "    " + l).join("\n") + "\n");
    }
    if (tool === "parallel" && result?.ok) {
      for (const r of result.results) process.stderr.write(p.dim(`    ↳ ${r.done ? "✓" : "·"} ${r.task.slice(0, 60)} — ${(r.summary || r.error || "").slice(0, 80)}\n`));
    }
    // live checklist: re-render when task_write changes it.
    if (tool === "task_write" && result?.ok) {
      const r = renderTasks(session.tools.tasks, p);
      if (r !== lastTasksRender) { process.stderr.write(r + "\n"); lastTasksRender = r; }
    }
  };

  let res;
  try {
    res = await session.runTurn(task, { onStep, beforeTool });
  } finally {
    session.closeMCP();
  }
  process.stderr.write("\n" + (res.summary ? res.summary + "\n" : ""));
  if (session.tools.tasks.length) process.stderr.write("\n" + renderTasks(session.tools.tasks, p) + "\n");
  process.stderr.write(footer({ turns: res.turns, totalTokens: res.totals.totalTokens, cost: res.totals.cost, model: session.provider.model }, p) + "\n");
  return res.done ? 0 : 1;
}

// ---- mcp subcommand ---------------------------------------------------------
//   cc-alt mcp list                       connect configured servers, print their tools
//   cc-alt mcp add <name> -- <command...> write a server into ./.cc-alt.json
async function runMcpCommand(args, config, p) {
  const sub = args[0];

  if (sub === "add") {
    // Re-read the raw argv so the `-- <command...>` part survives the flag parser.
    const raw = process.argv.slice(2);
    const i = raw.indexOf("add");
    const after = raw.slice(i + 1);
    const dashdash = after.indexOf("--");
    const name = after[0];
    if (!name || dashdash === -1 || dashdash === 0) {
      process.stderr.write(p.yellow("usage: cc-alt mcp add <name> -- <command> [args...]\n"));
      return 1;
    }
    const cmd = after.slice(dashdash + 1);
    if (!cmd.length) { process.stderr.write(p.yellow("no command after --\n")); return 1; }
    const target = path.join(process.cwd(), ".cc-alt.json");
    let cfg = {};
    try { if (fs.existsSync(target)) cfg = JSON.parse(fs.readFileSync(target, "utf8")); } catch { cfg = {}; }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[name] = { command: cmd[0], args: cmd.slice(1), env: {} };
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
    process.stdout.write(p.green(`added mcp server "${name}" → ${target}\n`));
    process.stdout.write(p.dim(`  ${cmd.join(" ")}\n`));
    return 0;
  }

  if (sub && sub !== "list") {
    process.stderr.write(p.yellow(`unknown: cc-alt mcp ${sub}\nusage: cc-alt mcp list | cc-alt mcp add <name> -- <command...>\n`));
    return 1;
  }

  // default: list
  if (!config.mcpServers || !Object.keys(config.mcpServers).length) {
    process.stdout.write(p.dim("no mcpServers configured (add an \"mcpServers\" block to .cc-alt.json or run: cc-alt mcp add <name> -- <command...>)\n"));
    return 0;
  }
  process.stderr.write(p.dim("connecting MCP servers…\n"));
  const { clients, catalog, errors } = await connectAll(config.mcpServers);
  try {
    const byServer = new Map();
    for (const t of catalog) {
      if (!byServer.has(t.server)) byServer.set(t.server, []);
      byServer.get(t.server).push(t);
    }
    for (const [server, tools] of byServer) {
      process.stdout.write(p.bold(`\n${server}`) + p.dim(`  (${tools.length} tool${tools.length === 1 ? "" : "s"})`) + "\n");
      for (const t of tools) {
        const desc = (t.description || "").replace(/\s+/g, " ").trim().slice(0, 80);
        process.stdout.write(`  ${p.cyan(t.id)}  ${p.gray(desc)}\n`);
      }
    }
    for (const e of errors) process.stdout.write(p.red(`\n${e.server}: ${e.error}\n`));
    if (!catalog.length && !errors.length) process.stdout.write(p.dim("no tools discovered.\n"));
  } finally {
    closeAll(clients);
  }
  return 0;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const { flags, positional, baseline, init, help, version, auto, plan } = parseArgs(process.argv.slice(2));
  const palette = makePalette(colorEnabled());
  const p = palette;

  if (version) { process.stdout.write(`cc-alt ${VERSION}\n`); return 0; }
  if (help) { process.stdout.write(HELP + "\n"); return 0; }

  if (init) {
    const r = writeStarterConfig(process.cwd());
    if (!r.ok) { process.stderr.write(p.yellow(`.cc-alt.json already exists at ${r.path}\n`)); return 1; }
    process.stdout.write(p.green(`wrote ${r.path}\n`));
    return 0;
  }

  // Resolve config (flags win). dir comes from --dir, the 2nd positional, or cwd.
  const subcommand = positional[0];
  const { config, sources, paths } = loadConfig({ flags });

  if (subcommand === "config") {
    process.stdout.write(p.bold("resolved config") + p.dim("  (precedence: flags > local > home > env > defaults)") + "\n");
    for (const [k, v] of Object.entries(config)) {
      const shown = k === "apiKey" ? (v ? "****(set)" : "(unset)") : v;
      process.stdout.write(`  ${k.padEnd(16)} ${String(shown).padEnd(40)} ${p.gray("← " + (sources[k] || "default"))}\n`);
    }
    process.stdout.write(p.gray(`  local: ${paths.local}${fs.existsSync(paths.local) ? "" : " (none)"}\n`));
    process.stdout.write(p.gray(`  home:  ${paths.home}${fs.existsSync(paths.home) ? "" : " (none)"}\n`));
    return 0;
  }

  if (subcommand === "mcp") {
    return runMcpCommand(positional.slice(1), config, p);
  }

  // One-shot vs REPL: a task string => one-shot. No task => REPL.
  const hasTask = !!subcommand;
  const dir = flags.dir || (hasTask ? positional[1] : undefined) || process.cwd();
  if (!fs.existsSync(dir)) { process.stderr.write(p.red(`directory not found: ${dir}\n`)); return 2; }

  if (hasTask) {
    if (baseline) {
      process.stderr.write(p.dim(`cc-alt --baseline · model ${config.model}\n`));
      const res = await runBaseline(subcommand, dir, { model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl, maxSteps: config.maxSteps });
      process.stderr.write(`\ndone=${res.done} turns=${res.turns} ${JSON.stringify(res.totals)}\n`);
      return res.done ? 0 : 1;
    }
    return runOneShot(subcommand, dir, config, palette, { auto, plan });
  }

  // REPL
  await startRepl({ workdir: dir, config, palette });
  return 0;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  process.stderr.write(`fatal: ${e?.stack || e?.message || e}\n`);
  process.exit(1);
});
