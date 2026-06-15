// project.mjs — auto-detect how to TEST / RUN / BUILD an arbitrary project (gap #1). So verify-repair
// and "run it" work on an existing repo the agent has never seen, with NO flags. Pure manifest
// inspection — zero LLM calls, zero dependencies. Confidence-ranked so the most authoritative signal
// (a real package.json test script) beats a weak guess.

import fs from "node:fs";
import path from "node:path";

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
const has = (dir, f) => fs.existsSync(path.join(dir, f));

// Detect { test, run, build } commands for the project at `dir`. Each is { cmd, confidence, why } or
// null. Inspects the manifest files in priority order; the first strong match per category wins.
export function detectCommands(dir) {
  const out = { test: null, run: null, build: null, ecosystem: null, evidence: [] };
  const set = (k, cmd, confidence, why) => { if (!out[k] || out[k].confidence < confidence) out[k] = { cmd, confidence, why }; };

  // --- Node / JS / TS ---
  if (has(dir, "package.json")) {
    out.ecosystem = "node"; out.evidence.push("package.json");
    const pkg = readJSON(path.join(dir, "package.json")) || {};
    const s = pkg.scripts || {};
    if (s.test && !/no test specified/i.test(s.test)) set("test", "npm test", 0.95, "package.json scripts.test");
    if (s.dev) set("run", "npm run dev", 0.9, "scripts.dev");
    else if (s.start) set("run", "npm start", 0.9, "scripts.start");
    else if (s.serve) set("run", "npm run serve", 0.8, "scripts.serve");
    if (s.build) set("build", "npm run build", 0.9, "scripts.build");
    if (pkg.bin || (pkg.main && !s.start)) set("run", `node ${typeof pkg.bin === "string" ? pkg.bin : pkg.main || "index.js"}`, 0.6, "package.json main/bin");
  }

  // --- Python ---
  if (has(dir, "manage.py")) { out.ecosystem = out.ecosystem || "python"; out.evidence.push("manage.py"); set("run", "python manage.py runserver", 0.9, "Django manage.py"); set("test", "python manage.py test", 0.85, "Django test"); }
  if (has(dir, "pyproject.toml") || has(dir, "setup.py") || has(dir, "setup.cfg") || has(dir, "pytest.ini") || has(dir, "tox.ini") || has(dir, "tests") || has(dir, "test")) {
    out.ecosystem = out.ecosystem || "python"; out.evidence.push("python project");
    const py = readJSON; void py;
    set("test", "pytest", 0.7, "python tests present");
    const pp = read(path.join(dir, "pyproject.toml"));
    if (/\[tool\.poetry\]/.test(pp)) set("test", "poetry run pytest", 0.75, "poetry");
  }
  if (has(dir, "requirements.txt") && has(dir, "app.py")) set("run", "python app.py", 0.6, "app.py");
  if (has(dir, "main.py") && !out.run) set("run", "python main.py", 0.55, "main.py");

  // --- Go ---
  if (has(dir, "go.mod")) { out.ecosystem = "go"; out.evidence.push("go.mod"); set("test", "go test ./...", 0.9, "go.mod"); set("build", "go build ./...", 0.85, "go.mod"); set("run", "go run .", 0.7, "go.mod"); }

  // --- Rust ---
  if (has(dir, "Cargo.toml")) { out.ecosystem = "rust"; out.evidence.push("Cargo.toml"); set("test", "cargo test", 0.9, "Cargo.toml"); set("run", "cargo run", 0.85, "Cargo.toml"); set("build", "cargo build", 0.85, "Cargo.toml"); }

  // --- Java / Kotlin ---
  if (has(dir, "pom.xml")) { out.ecosystem = out.ecosystem || "java"; out.evidence.push("pom.xml"); set("test", "mvn test", 0.85, "Maven"); set("build", "mvn package", 0.8, "Maven"); }
  if (has(dir, "build.gradle") || has(dir, "build.gradle.kts")) { out.ecosystem = out.ecosystem || "java"; out.evidence.push("gradle"); set("test", "gradle test", 0.85, "Gradle"); set("build", "gradle build", 0.8, "Gradle"); }

  // --- Ruby ---
  if (has(dir, "Gemfile")) {
    out.ecosystem = out.ecosystem || "ruby"; out.evidence.push("Gemfile");
    if (has(dir, "spec") || has(dir, ".rspec")) set("test", "bundle exec rspec", 0.8, "rspec");
    else if (has(dir, "Rakefile")) set("test", "bundle exec rake test", 0.7, "rake");
  }

  // --- Make (weak: only if it actually has the target) ---
  if (has(dir, "Makefile")) {
    const mk = read(path.join(dir, "Makefile")); out.evidence.push("Makefile");
    if (/^test\s*:/m.test(mk)) set("test", "make test", 0.65, "Makefile test target");
    if (/^run\s*:/m.test(mk)) set("run", "make run", 0.6, "Makefile run target");
    if (/^build\s*:/m.test(mk)) set("build", "make build", 0.6, "Makefile build target");
  }

  // --- Docker (fallback signal) ---
  if (has(dir, "docker-compose.yml") || has(dir, "compose.yaml") || has(dir, "docker-compose.yaml")) set("run", "docker compose up", 0.5, "compose file");

  return out;
}

// A short human/agent-facing summary line.
export function describeCommands(d) {
  const parts = [];
  for (const k of ["test", "run", "build"]) if (d[k]) parts.push(`${k}: ${d[k].cmd}`);
  return parts.length ? `${d.ecosystem || "project"} — ${parts.join("  ·  ")}` : "no test/run/build command detected (no recognizable manifest)";
}
