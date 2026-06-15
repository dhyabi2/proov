// gameharness.mjs — the agent's "hands + clock + X-ray" for web games (Block 15). The keystone that
// unlocks see-it-play / playtest / perf / balance / state checks. Zero new dependencies: it drives the
// game in the system's headless Chrome (reuses eye.mjs) — NO Chrome DevTools Protocol / WebSocket.
//
// Contract ("Simulacrum"): a slivr-built game exposes a deterministic control surface:
//   window.slivrSim = {
//     reset(seed),          // re-init deterministically (seed the RNG)
//     step(dtMs),           // advance ONE update+render by dtMs (no requestAnimationFrame)
//     input(key, isDown),   // set an input as held/released, e.g. input('ArrowRight', true)
//     state(),              // return a small JSON snapshot, e.g. {x, y, score, over}
//   }
// playGame() injects a driver that resets, applies a scripted input timeline, steps N frames, and
// records state snapshots — so the agent can verify the game ACTUALLY plays (moves, scores, ends).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderDom, renderShot } from "./eye.mjs";

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Build a harness HTML: the game + an injected driver that runs the Simulacrum and writes a JSON
// result into a hidden <pre> that --dump-dom can read back.
export function buildHarness(gameHtml, plan = {}) {
  const seed = plan.seed ?? 1, steps = plan.steps ?? 120, dt = plan.dt ?? 16;
  const inputs = JSON.stringify(plan.inputs || []);
  const driver = `<script>(function(){
  function out(o){var el=document.getElementById('__slivr_out');if(!el){el=document.createElement('pre');el.id='__slivr_out';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}
  function run(){try{
    var S=window.slivrSim;
    if(!S||typeof S.step!=='function'){out({error:'NO_SLIVR_SIM',hint:'the game must expose window.slivrSim={reset,step,input,state}'});return;}
    if(typeof S.reset==='function')S.reset(${seed});
    var INPUTS=${inputs},STEPS=${steps},DT=${dt},snaps=[],every=Math.max(1,Math.floor(STEPS/12));
    for(var i=0;i<STEPS;i++){
      for(var j=0;j<INPUTS.length;j++){if(INPUTS[j].at===i&&typeof S.input==='function')S.input(INPUTS[j].key,!!INPUTS[j].down);}
      S.step(DT);
      if(typeof S.state==='function'&&(i%every===0))snaps.push(S.state());
    }
    if(typeof S.state==='function')snaps.push(S.state());
    out({ok:true,steps:STEPS,snapshots:snaps});
  }catch(e){out({error:String(e&&e.message||e)});}}
  if(document.readyState==='complete')run();else window.addEventListener('load',run);
})();</script>`;
  return /<\/body>/i.test(gameHtml) ? gameHtml.replace(/<\/body>/i, driver + "</body>") : gameHtml + driver;
}

// Drive a game and observe it. Returns { ok, result:{snapshots|error}, screenshot } | { ok:false, error }.
// plan: { seed, steps, dt, inputs:[{at,key,down}] }.
export function playGame(htmlAbs, plan = {}) {
  const gameHtml = read(htmlAbs);
  if (!gameHtml) return { ok: false, error: "FILE_NOT_FOUND_OR_EMPTY" };
  const dir = path.dirname(htmlAbs);                 // keep relative assets resolving
  const tmp = path.join(dir, `.slivr-harness-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, buildHarness(gameHtml, plan));
    const dom = renderDom(tmp);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_out"[^>]*>([\s\S]*?)<\/pre>/);
    let result = null;
    if (m) { try { result = JSON.parse(decodeEntities(m[1])); } catch { /* leave null */ } }
    // final-frame screenshot (re-runs the deterministic driver, captures the end state)
    let screenshot = null;
    const png = path.join(os.tmpdir(), `slivr-game-${process.pid}-${Date.now()}.png`);
    const shot = renderShot(tmp, png);
    if (shot.ok) { try { screenshot = "data:image/png;base64," + fs.readFileSync(png).toString("base64"); } catch { /* */ } try { fs.unlinkSync(png); } catch { /* */ } }
    return { ok: true, result, screenshot };
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
