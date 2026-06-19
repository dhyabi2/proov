// visuallint.mjs — DETERMINISTIC visual lint (Block 80). Render-level checks an LLM judge can't fudge: it
// instruments the 2D canvas BEFORE the game draws and records, while the game runs, draws that are OFF-CANVAS,
// ZERO/negative SIZE, or the SAME colour as the background (invisible). Catches the look bugs the vision
// checklist misses (an off-screen / behind-the-scenery / same-colour-as-bg HUD that the code "defines" but
// nobody can see). Browser-executed (skipped with no Chrome); pure helpers are unit-testable.
import fs from "node:fs";
import path from "node:path";
import { renderDomGL, renderDom } from "./eye.mjs";

// Head-injected instrumentation. Wraps getContext('2d') so every later canvas wraps its draw ops; drives a
// little input so the game actually renders frames; writes a JSON tally to a hidden <pre>.
export function lintInject(budget = 9000, keys = ["ArrowRight", "ArrowUp", "Space"]) {
  return `<script>(function(){
  // visibility tally (off/zero/invis) + RICHNESS tally (Block 86): how the scene is DRAWN — flat rects vs real
  // sprites (drawImage), vector shapes (fill/stroke of a path), gradients/patterns, and text. This lets a model-
  // FREE check tell "designed/painted assets" from "everything is a plain coloured box" (the placeholder look).
  var O={off:0,zero:0,invis:0,total:0,bg:null,rects:0,rectArea:0,imgs:0,paths:0,grads:0,texts:0,cArea:0,cols:{},ncols:0};
  function ck(s){return (''+s).replace(/\\s+/g,'').toLowerCase();}
  function col(style){ if(typeof style==='string'){var c=ck(style); if(!O.cols[c]){if(O.ncols<60){O.cols[c]=1;O.ncols++;}}} else if(style){O.grads++;} }
  var orig=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(t){
    var ctx=orig.apply(this,arguments); if(t!=='2d'||!ctx||ctx.__pl)return ctx; ctx.__pl=1; var cv=this;
    function inb(x,y,w,h){return (x+w)>0&&(y+h)>0&&x<cv.width&&y<cv.height;}
    function rec(x,y,w,h,style){O.total++;
      if(w<=0||h<=0){O.zero++;return;}
      if(!inb(x,y,w,h)){O.off++;return;}
      if((w*h)>=0.7*cv.width*cv.height&&style){O.bg=ck(style);}
      else if(O.bg&&style&&typeof style==='string'&&ck(style)===O.bg){O.invis++;}
    }
    var fr=ctx.fillRect.bind(ctx); ctx.fillRect=function(x,y,w,h){O.rects++;O.rectArea+=Math.max(0,w)*Math.max(0,h);O.cArea=Math.max(O.cArea,cv.width*cv.height);col(ctx.fillStyle);rec(x,y,w,h,ctx.fillStyle);return fr(x,y,w,h);};
    var sr=ctx.strokeRect.bind(ctx); ctx.strokeRect=function(x,y,w,h){O.rects++;O.rectArea+=Math.max(0,w)*Math.max(0,h);O.cArea=Math.max(O.cArea,cv.width*cv.height);col(ctx.strokeStyle);rec(x,y,w,h,ctx.strokeStyle);return sr(x,y,w,h);};
    var di=ctx.drawImage.bind(ctx); ctx.drawImage=function(){var a=arguments;O.imgs++; if(a.length>=5){rec(a[1],a[2],a[3],a[4],null);} else if(a.length>=3){var im=a[0];rec(a[1],a[2],(im&&(im.width||im.videoWidth))||0,(im&&(im.height||im.videoHeight))||0,null);} return di.apply(ctx,a);};
    var ftn=ctx.fillText.bind(ctx); ctx.fillText=function(s,x,y){O.total++;O.texts++; if(O.bg&&ck(ctx.fillStyle)===O.bg){O.invis++;} return ftn.apply(ctx,arguments);};
    // vector shapes (a drawn character / curve / polygon) — fill()/stroke() of a built path is real form, not a box.
    var fl=ctx.fill.bind(ctx); ctx.fill=function(){O.paths++;col(ctx.fillStyle);return fl.apply(ctx,arguments);};
    var st=ctx.stroke.bind(ctx); ctx.stroke=function(){O.paths++;col(ctx.strokeStyle);return st.apply(ctx,arguments);};
    if(ctx.putImageData){var pid=ctx.putImageData.bind(ctx); ctx.putImageData=function(){O.imgs++;return pid.apply(ctx,arguments);};}
    return ctx;
  };
  function fire(){var keys=${JSON.stringify(keys)};keys.forEach(function(k){var c=(k==='Space')?' ':k,kc=(k==='ArrowRight')?39:(k==='ArrowUp')?38:(k==='ArrowLeft')?37:(k==='ArrowDown')?40:32;[document,window].forEach(function(tg){try{tg.dispatchEvent(new KeyboardEvent('keydown',{key:c,code:k,keyCode:kc,which:kc,bubbles:true}));}catch(e){}});});}
  window.addEventListener('load',function(){var n=0;(function loop(){fire();n+=200;if(n>=${Math.max(2000, budget - 1500)}){var p=document.createElement('pre');p.id='__proov_lint';p.style.display='none';p.textContent=JSON.stringify(O);document.body.appendChild(p);return;}setTimeout(loop,200);})();});
  })();</script>`;
}

// Parse the lint tally out of a rendered DOM string. Returns the tally object or null.
export function parseLint(dom) {
  const m = String(dom || "").match(/<pre id="__proov_lint"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { return null; }
}

// PLACEHOLDER-ART verdict (Block 86) — the model-FREE answer to "is this designed/painted, or just flat boxes?"
// The dishonest-review hole: when the active model can't see images (a code model), the vision flat-box check
// no-ops and nothing else measures FIDELITY. This does, from the draw composition alone — no model, no game-
// specific knowledge. It fires ONLY on a degenerate render: entirely flat rectangles, few colours, and NOT a
// single sprite (drawImage), vector shape (fill/stroke path), gradient/pattern, or text. All metrics are frame-
// count invariant (ratios / distinct sets / means), so it's robust to however many frames were captured. It is
// deliberately CONSERVATIVE — any real detail (a drawn curve, a gradient-shaded block, a sprite, a label, or
// pixel-art's many small cells) lifts the scene out of "placeholder" — so intentional minimalism isn't punished.
export function richnessIssue(o) {
  if (!o) return null;
  const rects = o.rects || 0;
  const rich = (o.imgs || 0) + (o.paths || 0) + (o.grads || 0) + (o.texts || 0);
  if (rects < 4) return null;            // too little drawn to judge a "look"
  if (rich > 0) return null;             // any sprite / vector shape / gradient / text → not placeholder-grade
  const colors = o.ncols || 0;
  if (colors > 12) return null;          // a rich palette (incl. hand-placed pixel art) → not a few flat boxes
  const meanAreaPct = (o.cArea > 0 && rects > 0) ? 100 * (o.rectArea / rects) / o.cArea : 0;
  if (meanAreaPct < 0.15) return null;   // many tiny rects = pixel-art cells, not entity-sized placeholder boxes
  return `every element renders as a PLAIN FLAT COLOURED BOX — the whole scene is ${colors} flat colour${colors === 1 ? "" : "s"} of rectangles with NO sprites, NO gradient/shaded fills, NO drawn shapes (curves/polygons), and NO text. This is placeholder-grade art, not designed/painted assets`;
}

// Turn a tally into human issues. Pure + unit-testable.
export function lintIssues(o) {
  if (!o) return [];
  const issues = [];
  const visible = (o.total || 0) - (o.off || 0) - (o.zero || 0) - (o.invis || 0);
  if (o.off > 0) issues.push(`${o.off} draw${o.off === 1 ? " is" : "s are"} OFF-CANVAS (drawn outside the visible area — the player can't see ${o.off === 1 ? "it" : "them"})`);
  if (o.zero > 0) issues.push(`${o.zero} draw${o.zero === 1 ? " has" : "s have"} ZERO / negative size (nothing renders)`);
  if (o.invis > 0) issues.push(`${o.invis} element${o.invis === 1 ? " is" : "s are"} the SAME colour as the background (invisible — e.g. text/HUD you can't read)`);
  if ((o.total || 0) > 0 && visible < 3) issues.push(`almost nothing is actually visible on the canvas (only ${visible} of ${o.total} draw ops land on screen)`);
  const rich = richnessIssue(o);
  if (rich) issues.push(rich);
  return issues;
}

// Run the lint on a static game HTML file. Returns { ran, issues:[...], raw } or { ran:false }.
export function visualLint(htmlAbs, { budget = 9000 } = {}) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ran: false }; }
  const inj = lintInject(budget);
  // inject at the TOP of <head> so it wraps getContext BEFORE the game's scripts call it.
  const out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inj) : inj + html;
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.proov-lint-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, out);
    const dom = renderDomGL(tmp, budget);
    if (!dom.ok) return { ran: false };
    const o = parseLint(dom.dom);
    if (!o) return { ran: false };
    return { ran: true, issues: lintIssues(o), raw: o };
  } catch { return { ran: false }; }
  finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}

// ── DOM visual lint (Block 81) ── for a normal web UI (not a canvas game). Detects render-level look bugs the
// game/canvas lint can't see: VISIBLE elements that render at ZERO size, elements positioned OFF-SCREEN
// (outside the viewport), text with LOW CONTRAST vs its background (WCAG AA < 4.5), and horizontal OVERFLOW
// (clipped content / broken layout). Injected DOM walk; browser-executed; pure helpers are unit-testable.
export function domLintInject() {
  return `<script>window.addEventListener('load',function(){setTimeout(function(){try{
  function lum(c){var m=(''+c).match(/[0-9.]+/g);if(!m||m.length<3)return null;var a=m.slice(0,3).map(function(v){v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2];}
  function bgOf(el){var e=el;while(e){var c=getComputedStyle(e).backgroundColor;if(c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c;e=e.parentElement;}return 'rgb(255,255,255)';}
  var O={zero:0,off:0,lowContrast:0,overflowX:0,textNodes:0};
  var vw=window.innerWidth||1024,vh=window.innerHeight||768;
  var all=document.body?document.body.querySelectorAll('*'):[];
  for(var i=0;i<all.length;i++){var el=all[i];var s=getComputedStyle(el);
    if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity||'1')<0.05)continue;
    var r=el.getBoundingClientRect();
    var txt=el.childNodes.length&&[].some.call(el.childNodes,function(n){return n.nodeType===3&&n.textContent.trim().length>1;});
    if(txt){O.textNodes++;
      if(r.width<1||r.height<1)O.zero++;
      if(r.right<0||r.bottom<0||r.left>vw||r.top>vh)O.off++;
      var fl=lum(s.color),bl=lum(bgOf(el));
      if(fl!=null&&bl!=null){var L1=Math.max(fl,bl)+0.05,L2=Math.min(fl,bl)+0.05;if(L1/L2<4.5)O.lowContrast++;}
    }
    if(el.scrollWidth>el.clientWidth+8&&s.overflowX!=='auto'&&s.overflowX!=='scroll'&&s.overflowX!=='hidden')O.overflowX++;
  }
  var p=document.createElement('pre');p.id='__proov_domlint';p.style.display='none';p.textContent=JSON.stringify(O);document.body.appendChild(p);
  }catch(e){}},700);});</script>`;
}
export function parseDomLint(dom) {
  const m = String(dom || "").match(/<pre id="__proov_domlint"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); } catch { return null; }
}
// Conservative: block only on UNAMBIGUOUS bugs (zero-size text, off-screen). Low-contrast/overflow need a
// higher count before flagging (they false-positive on image backgrounds / intentional scroll areas).
export function domLintIssues(o) {
  if (!o) return [];
  const is = [];
  if (o.zero > 0) is.push(`${o.zero} text element${o.zero === 1 ? "" : "s"} render at ZERO size (invisible)`);
  if (o.off > 0) is.push(`${o.off} element${o.off === 1 ? " is" : "s are"} positioned OFF-SCREEN (outside the viewport)`);
  if (o.lowContrast > 3) is.push(`${o.lowContrast} text elements have LOW CONTRAST vs their background (hard to read — WCAG AA < 4.5)`);
  if (o.overflowX > 1) is.push(`${o.overflowX} elements OVERFLOW horizontally (content clipped / layout breaks)`);
  return is;
}
export function domLint(htmlAbs) {
  let html = ""; try { html = fs.readFileSync(htmlAbs, "utf8"); } catch { return { ran: false }; }
  const inj = domLintInject();
  const out = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, inj + "</body>") : html + inj;
  const dir = path.dirname(htmlAbs);
  const tmp = path.join(dir, `.proov-domlint-${process.pid}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmp, out);
    const dom = renderDom(tmp);
    if (!dom.ok) return { ran: false };
    const o = parseDomLint(dom.dom);
    if (!o) return { ran: false };
    return { ran: true, issues: domLintIssues(o), raw: o };
  } catch { return { ran: false }; } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}
