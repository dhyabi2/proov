// ui.mjs — terminal presentation: colors, live step rendering, prompts, per-turn footer.
//
// Degrades gracefully: no color when not a TTY, when NO_COLOR is set, or color:false is forced.
// Pure formatting helpers (fmt*, stepLine, footer) are testable without a terminal; the prompt
// helpers (confirm) do real stdin I/O and are only used in the REPL.

import readline from "node:readline";

const RAW = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

export function colorEnabled({ stream = process.stdout, env = process.env } = {}) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR) return true;
  return !!(stream && stream.isTTY);
}

// Build a color palette; when disabled every function is identity (returns the text unchanged).
export function makePalette(enabled) {
  const wrap = (code) => enabled ? (s) => code + s + RAW.reset : (s) => s;
  return {
    enabled,
    reset: RAW.reset,
    bold: wrap(RAW.bold), dim: wrap(RAW.dim),
    red: wrap(RAW.red), green: wrap(RAW.green), yellow: wrap(RAW.yellow),
    blue: wrap(RAW.blue), magenta: wrap(RAW.magenta), cyan: wrap(RAW.cyan), gray: wrap(RAW.gray),
  };
}

// Pretty-print a tool target, e.g. edit src/foo.js, run `node test.js`, grep "TODO".
export function describeStep({ tool, args = {} }) {
  switch (tool) {
    case "read_file": return `read ${args.path ?? "?"}`;
    case "list_dir": return `list ${args.path ?? "."}`;
    case "grep": return `grep ${JSON.stringify(args.pattern ?? "")}${args.path && args.path !== "." ? " in " + args.path : ""}`;
    case "run_command": return `run \`${(args.command ?? "").slice(0, 80)}\``;
    case "edit_file": return `edit ${args.path ?? "?"}`;
    case "create_file": return `create ${args.path ?? "?"}`;
    case "write_file": return `write ${args.path ?? "?"}`;
    case "done": return `done`;
    default: return tool;
  }
}

// A single rendered step line for streaming output. status ∈ 'run'|'ok'|'fail'|'skip'.
export function stepLine({ tool, args, status = "ok", extra = "", palette }) {
  const p = palette;
  const icon = status === "fail" ? p.red("✗") : status === "skip" ? p.yellow("∅")
    : status === "run" ? p.cyan("●") : p.green("✓");
  const desc = describeStep({ tool, args });
  const tail = extra ? p.dim(" " + extra) : "";
  return `  ${icon} ${desc}${tail}`;
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString("en-US");
}

// Per-turn footer, e.g.  · 4 turns · 5,912 tok · $0.0021
export function footer({ turns, totalTokens, cost, model }, palette) {
  const p = palette;
  const parts = [
    `${turns} turn${turns === 1 ? "" : "s"}`,
    `${formatNumber(totalTokens)} tok`,
    `$${Number(cost || 0).toFixed(4)}`,
  ];
  if (model) parts.push(p.gray(model));
  return p.dim("· " + parts.join(" · "));
}

// Banner shown when the REPL starts.
export function banner({ model, approval, cwd }, palette) {
  const p = palette;
  return [
    p.bold("cc-alt") + p.dim(" — interactive coding agent"),
    p.gray(`model ${model} · approval ${approval} · ${cwd}`),
    p.gray("type a request, or /help for commands. /exit to quit."),
  ].join("\n");
}

// --- plan-mode + task-management presentation ---------------------------------

// Render a recorded plan as a numbered list. plan = { steps:[...], approved }.
export function renderPlan(plan, palette) {
  const p = palette || makePalette(false);
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return p.dim("(no plan)");
  const head = p.bold("plan") + p.dim(` (${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"})`);
  const body = plan.steps.map((s, i) => `  ${p.cyan(String(i + 1) + ".")} ${s}`).join("\n");
  return head + "\n" + body;
}

const TASK_GLYPH = { pending: "☐", in_progress: "◐", completed: "✓" };

// Render the live task checklist. tasks = [{id, subject, status}].
export function renderTasks(tasks, palette) {
  const p = palette || makePalette(false);
  if (!Array.isArray(tasks) || !tasks.length) return p.dim("(no tasks)");
  const lines = tasks.map((t) => {
    const g = TASK_GLYPH[t.status] || "☐";
    const mark = t.status === "completed" ? p.green(g)
      : t.status === "in_progress" ? p.yellow(g) : p.dim(g);
    const label = t.status === "completed" ? p.dim(t.subject) : t.subject;
    return `  ${mark} ${label}`;
  });
  const done = tasks.filter(t => t.status === "completed").length;
  return p.bold("tasks") + p.dim(` (${done}/${tasks.length})`) + "\n" + lines.join("\n");
}

// Three-way plan prompt: yes / edit / no. Returns "yes" | "edit" | "no". Non-TTY -> "no".
// (auto-approval is handled by the caller before this is ever invoked.)
export function planPrompt(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY) { output.write(question + " [auto: non-interactive]\n"); return resolve("no"); }
    const rl = readline.createInterface({ input, output });
    rl.question(question + " [y]es / [e]dit / [n]o: ", (ans) => {
      rl.close();
      const a = (ans || "").trim().toLowerCase();
      if (/^e/.test(a)) return resolve("edit");
      if (/^n/.test(a)) return resolve("no");
      resolve("yes"); // default yes
    });
  });
}

// Read a multi-line revised plan from the user (one step per line; blank line ends). Returns [steps].
export function readPlanEdit({ input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY) return resolve([]);
    output.write("enter revised plan, one step per line; blank line to finish:\n");
    const rl = readline.createInterface({ input, output });
    const steps = [];
    rl.prompt && rl.setPrompt("  · ");
    rl.on("line", (line) => {
      if (!line.trim()) { rl.close(); return; }
      steps.push(line.trim());
    });
    rl.on("close", () => resolve(steps));
  });
}

// y/N confirmation on a fresh readline (used outside the main REPL rl to avoid event tangles).
// Returns a Promise<boolean>. Default is NO. Honors a non-TTY stdin by returning false.
export function confirm(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY) { output.write(question + " [auto-deny: non-interactive]\n"); return resolve(false); }
    const rl = readline.createInterface({ input, output });
    rl.question(question + " [y/N] ", (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test((ans || "").trim()));
    });
  });
}
