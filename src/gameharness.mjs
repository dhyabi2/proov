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

// --- Multi-level (Block 23 "Levels"): drive EVERY level and verify each loads, is DISTINCT (not a clone
// of level 1), plays, and — where the state exposes it — is completable. Extends the Simulacrum contract:
//   window.slivrSim.levels      // number of levels (or an array of level data)
//   window.slivrSim.load(i)     // load level i deterministically (or reset(i) if no load)
// plus the existing step/input/state. This is the verification surface for multi-level games.

// Build a harness that iterates levels: load each, snapshot its initial state (structural fingerprint),
// drive scripted inputs (behavioral check), and capture each level's initial frame for a contact sheet.
export function buildLevelsHarness(gameHtml, plan = {}) {
  const steps = plan.steps ?? 60, dt = plan.dt ?? 16, cap = plan.cap ?? 24;
  const inputs = JSON.stringify(plan.inputs || [{ at: 0, key: "ArrowRight", down: true }, { at: 0, key: "ArrowUp", down: true }, { at: 0, key: "Space", down: true }]);
  const driver = `<script>(function(){
  function out(o){var el=document.getElementById('__slivr_levels');if(!el){el=document.createElement('pre');el.id='__slivr_levels';el.style.display='none';document.body.appendChild(el);}el.textContent=JSON.stringify(o);}
  // canonical signature of a state, IGNORING any level-index field so a clone that only changes the index is still caught.
  function sig(s){try{if(s==null)return 'null';var o={};Object.keys(s).sort().forEach(function(k){if(/^(level|levelindex|index|stage|lvl)$/i.test(k))return;var v=s[k];o[k]=(typeof v==='number')?Math.round(v*10)/10:v;});return JSON.stringify(o);}catch(e){return String(s);}}
  function run(){try{
    var S=window.slivrSim;
    if(!S){out({error:'NO_SLIVR_SIM',hint:'expose window.slivrSim'});return;}
    var loadFn=(typeof S.load==='function')?function(i){return S.load(i);}:((typeof S.reset==='function')?function(i){return S.reset(i);}:null);
    if(!loadFn){out({error:'NO_LEVELS_CONTRACT',hint:'expose slivrSim.load(i) (or reset(i)) and slivrSim.levels (count or array)'});return;}
    var N=(typeof S.levels==='number')?S.levels:(Array.isArray(S.levels)?S.levels.length:null);
    var INPUTS=${inputs},STEPS=${steps},DT=${dt},CAP=${cap};
    var cv=document.querySelector('canvas');
    var levels=[],max=(N!=null)?Math.min(N,CAP):CAP;
    for(var i=0;i<max;i++){
      var loaded=true;
      try{var r=loadFn(i);if(N==null&&r===false){break;}}catch(e){if(N==null){break;}loaded=false;}
      var s0=(typeof S.state==='function')?S.state():null;
      for(var k=0;k<STEPS;k++){for(var j=0;j<INPUTS.length;j++){if(INPUTS[j].at===k&&typeof S.input==='function')S.input(INPUTS[j].key,!!INPUTS[j].down);}if(typeof S.step==='function')S.step(DT);}
      var s1=(typeof S.state==='function')?S.state():null;
      var won=false;try{won=!!(s1&&(s1.won||s1.cleared||s1.complete||(s1.over&&s1.win)));}catch(e){}
      levels.push({index:i,loaded:loaded,sig:sig(s0),changed:sig(s0)!==sig(s1),won:won,frame:(cv?cv.toDataURL('image/png'):null)});
    }
    out({ok:true,count:levels.length,declared:N,levels:levels});
  }catch(e){out({error:String(e&&e.message||e)});}}
  if(document.readyState==='complete')setTimeout(run,150);else window.addEventListener('load',function(){setTimeout(run,150);});
})();</script>`;
  return /<\/body>/i.test(gameHtml) ? gameHtml.replace(/<\/body>/i, driver + "</body>") : gameHtml + driver;
}

// Contact sheet of each level's initial frame (so the agent SEES the levels are visually distinct).
function levelsSheetHtml(frames) {
  const cells = frames.map((f, i) => `<div style="text-align:center">${f ? `<img src="${f}" style="width:180px;height:auto;border:1px solid #333;background:#000">` : `<div style="width:180px;height:120px;background:#222;color:#888;display:flex;align-items:center;justify-content:center">no frame</div>`}<div style="color:#bbb;font:11px monospace;margin-top:3px">level ${i + 1}</div></div>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#0b0b0b;padding:8px;display:flex;flex-wrap:wrap;gap:8px">${cells}</body></html>`;
}

// Drive every level and report per-level loads/distinct/plays/won + an overall distinctness verdict.
export function playLevels(htmlAbs, plan = {}) {
  const gameHtml = read(htmlAbs);
  if (!gameHtml) return { ok: false, error: "FILE_NOT_FOUND_OR_EMPTY" };
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.slivr-levels-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, buildLevelsHarness(gameHtml, plan));
    const dom = renderDom(tmp);
    if (!dom.ok) return { ok: false, error: dom.error };
    const m = dom.dom.match(/<pre id="__slivr_levels"[^>]*>([\s\S]*?)<\/pre>/);
    let res = null;
    if (m) { try { res = JSON.parse(decodeEntities(m[1])); } catch { /* */ } }
    if (!res) return { ok: false, error: "LEVELS_PARSE_FAILED" };
    if (res.error) return { ok: false, error: res.error, hint: res.hint };
    // distinctness: group by signature — duplicate signatures across levels are clones.
    const counts = {};
    for (const l of res.levels) counts[l.sig] = (counts[l.sig] || 0) + 1;
    const clones = res.levels.filter((l) => counts[l.sig] > 1).map((l) => l.index + 1);
    const uniqueSigs = Object.keys(counts).length;
    const levels = res.levels.map((l) => ({ level: l.index + 1, loads: l.loaded, plays: l.changed, distinct: counts[l.sig] === 1, completable: l.won }));
    // contact sheet of initial frames
    let dataUrl = null;
    const png = path.join(os.tmpdir(), `slivr-levels-${process.pid}-${Date.now()}.png`);
    const sheet = path.join(os.tmpdir(), `slivr-levels-${process.pid}-${Date.now()}.html`);
    try {
      fs.writeFileSync(sheet, levelsSheetHtml(res.levels.slice(0, 12).map((l) => l.frame)));
      const shot = renderShot(sheet, png, { width: 1100, height: 700 });
      if (shot.ok) dataUrl = "data:image/png;base64," + fs.readFileSync(png).toString("base64");
    } catch { /* */ } finally { try { fs.unlinkSync(png); } catch { /* */ } try { fs.unlinkSync(sheet); } catch { /* */ } }
    return { ok: true, count: res.count, declared: res.declared, uniqueLevels: uniqueSigs, clones, levels, dataUrl };
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
