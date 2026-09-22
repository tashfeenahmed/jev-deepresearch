/**
 * The canvas. Nodes arrive one event at a time, so the layout is recomputed
 * as siblings land and cards glide apart to make room — the graph settles
 * rather than being drawn once.
 */
const $ = id => document.getElementById(id);
const icons = () => window.lucide?.createIcons?.();
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ------------------------------------------------------------------ theme */
const saved = store.get("sl-theme");
if (saved) document.documentElement.setAttribute("data-theme", saved);
$("theme").onclick = () => {
  const now = document.documentElement.getAttribute("data-theme")
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = now === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  store.set("sl-theme", next);
};

/* ------------------------------------------------------------------ state */
const world = $("world"), wires = $("wires"), stage = $("stage");
const CX = 4200, CY = 3400;
const radius = d => d === 0 ? 0 : 300 * Math.pow(d, 0.72);

let nodes = new Map();      // id -> {id,parent,depth,...,x,y,ang,el,wire}
let maxDepth = 3, minSources = 10, runId = null, es = null, running = false, cameraLocked = false;
let hueSeed = new Map();

const hueOf = host => {
  if (!hueSeed.has(host)) {
    let h = 0; for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 360;
    hueSeed.set(host, h);
  }
  return hueSeed.get(host);
};

/* ----------------------------------------------------------------- camera */
let cam = { x: 0, y: 0, s: 1 };
const MINS = 0.05, MAXS = 3;
const applyCam = () => { world.style.transform = `translate(${cam.x.toFixed(1)}px,${cam.y.toFixed(1)}px) scale(${cam.s.toFixed(4)})`; };
const anim = on => world.classList.toggle("manual", !on);
const drawerW = () => ($("drawer").classList.contains("open") && innerWidth > 760) ? $("drawer").offsetWidth : 0;

function frame(pts, pad = 260, maxScale = 1.05) {
  if (!pts.length) return;
  anim(true);
  const r = stage.getBoundingClientRect(), avail = r.width - drawerW();
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const w = Math.max(420, Math.max(...xs) - Math.min(...xs) + pad * 2);
  const h = Math.max(340, Math.max(...ys) - Math.min(...ys) + pad * 2);
  const s = Math.max(MINS, Math.min(avail / w, r.height / h, maxScale));
  cam = { s, x: avail / 2 - (Math.min(...xs) + Math.max(...xs)) / 2 * s, y: r.height / 2 - (Math.min(...ys) + Math.max(...ys)) / 2 * s };
  applyCam();
}
const fitAll = () => { const pts = [...nodes.values()]; frame(pts.length ? pts : [{ x: CX, y: CY }], 260); };
function dive(n, s = 1.8) {
  anim(true);
  const r = stage.getBoundingClientRect(), avail = r.width - drawerW();
  cam = { s, x: avail / 2 - (n.x + 90) * s, y: r.height / 2 - n.y * s };
  applyCam();
}

let panning = false, last = null;
let startPan = { x: 0, y: 0 };
stage.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  panning = true; cameraLocked = true; last = { x: e.clientX, y: e.clientY };
  startPan = { x: e.clientX, y: e.clientY };
  stage.classList.add("dragging"); anim(false); stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", e => {
  if (!panning) return;
  cam.x += e.clientX - last.x; cam.y += e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY }; applyCam();
});
const endPan = e => {
  const wasDrag = panning && last && Math.hypot(e?.clientX - startPan.x, e?.clientY - startPan.y) > 4;
  panning = false; stage.classList.remove("dragging");
  if (!wasDrag && !e?.target?.closest?.(".node")) deselect();   // a click on bare canvas
};
stage.addEventListener("pointerup", endPan); stage.addEventListener("pointercancel", endPan);
stage.addEventListener("wheel", e => {
  e.preventDefault(); cameraLocked = true; anim(false);
  const r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const wx = (px - cam.x) / cam.s, wy = (py - cam.y) / cam.s;
  cam.s = Math.max(MINS, Math.min(MAXS, cam.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022))));
  cam.x = px - wx * cam.s; cam.y = py - wy * cam.s; applyCam();
}, { passive: false });

/* ----------------------------------------------------------------- layout
   Radial tree, but a crowded depth does NOT become one enormous circle. It
   becomes several concentric bands.

   1. Angles come from the tree: a subtree's slice is proportional to its LEAF
      count, so slices never overlap and neither do the subtrees inside them.
   2. Each depth then seats its cards in as many bands as it needs. Cards are
      sorted by angle and dealt round-robin into the bands, so neighbours
      alternate inner/outer and each band carries only 1/k of the ring —
      which multiplies the space between cards by k without inflating radius.
   3. Ring d starts outside the OUTERMOST band of ring d-1, so bands never
      collide with the next depth either.                                      */
const CARD_W = 178;        // card width plus the gap it wants from a neighbour
const BAND = 150;          // radial distance between bands of the same depth
const RING_GAP = 300;      // clear space between one depth and the next
const MAX_BANDS = 5;
const SQUASH = 0.82;       // rings are wider than tall

function relayout() {
  const root = nodes.get("n0");
  if (!root) return;

  const real = [...nodes.values()].filter(n => n.id !== "__report");
  const kids = new Map();
  for (const n of real) {
    if (!n.parent) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }

  // leaves per subtree, deepest first
  const leaves = new Map();
  for (const n of [...real].sort((a, b) => b.depth - a.depth)) {
    const ch = kids.get(n.id);
    leaves.set(n.id, ch?.length ? ch.reduce((t, c) => t + (leaves.get(c.id) || 1), 0) : 1);
  }

  // ---- 1. angle only, from the tree ----------------------------------------
  root.x = CX; root.y = CY;
  const walk = (node, a0, a1) => {
    const ch = kids.get(node.id);
    if (!ch?.length) return;
    const total = ch.reduce((t, c) => t + (leaves.get(c.id) || 1), 0) || 1;
    let a = a0;
    for (const c of ch) {
      const span = (a1 - a0) * ((leaves.get(c.id) || 1) / total);
      c.ang = a + span / 2;
      walk(c, a, a + span);
      a += span;
    }
  };
  walk(root, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);

  // ---- 2. bands per depth, 3. each depth clears the last -------------------
  const byDepth = new Map();
  for (const n of real) {
    if (!n.depth) continue;
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  }

  let prevOuter = 0;
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ring = byDepth.get(d).sort((a, b) => a.ang - b.ang);
    const inner = prevOuter + RING_GAP;
    const perBand = Math.max(1, Math.floor((2 * Math.PI * inner * SQUASH) / CARD_W));
    const bands = Math.min(MAX_BANDS, Math.max(1, Math.ceil(ring.length / perBand)));

    /* A card keeps the band it was first seated in. Re-dealing by angle on
       every arrival made half the ring hop between bands each time a sibling
       landed, which read as flicker. A newcomer takes a band its angular
       neighbours are not on, so the inner/outer alternation still emerges. */
    const count = new Array(bands).fill(0);
    for (const n of ring) if (n.band != null && n.band < bands) count[n.band]++; else n.band = null;
    ring.forEach((n, i) => {
      if (n.band != null) return;
      const near = new Set([ring[(i + ring.length - 1) % ring.length].band, ring[(i + 1) % ring.length].band]);
      let best = -1;
      for (let b = 0; b < bands; b++) if (!near.has(b) && (best < 0 || count[b] < count[best])) best = b;
      if (best < 0) best = count.indexOf(Math.min(...count));
      n.band = best; count[best]++;
    });
    for (const n of ring) {
      if (n.pinned) continue;
      const r = inner + n.band * BAND;
      n.x = CX + Math.cos(n.ang) * r;
      n.y = CY + Math.sin(n.ang) * r * SQUASH;
    }
    prevOuter = inner + (bands - 1) * BAND;
  }

  for (const n of real) {
    if (!n.el) continue;
    /* Every arrival re-divides the ring, so every card's ideal spot drifts by a
       few pixels each time. Cards only move for a real change; otherwise a
       hundred cards creep continuously and the board never looks settled. */
    if (n.px != null && Math.hypot(n.x - n.px, n.y - n.py) < 14) { n.x = n.px; n.y = n.py; continue; }
    const first = n.px == null;
    n.px = n.x; n.py = n.y;
    if (first) {
      // seat it without a glide, then let it fade in there
      n.el.style.transition = "none"; place(n.el, n.x, n.y); void n.el.offsetWidth; n.el.style.transition = "";
      requestAnimationFrame(() => n.el.classList.add("in"));
    } else place(n.el, n.x, n.y);
    if (n.wire) setWire(n);
  }
  const lay = nodes.get("__report");
  if (lay?.el && !lay.pinned) { lay.x = CX; lay.y = CY; place(lay.el, CX, CY); }
}

const WORLD_W = CX * 2, WORLD_H = CY * 2;
world.style.width = WORLD_W + "px"; world.style.height = WORLD_H + "px";
wires.setAttribute("viewBox", `0 0 ${WORLD_W} ${WORLD_H}`); wires.style.width = WORLD_W + "px"; wires.style.height = WORLD_H + "px";
function setWire(n) {
  const par = nodes.get(n.parent); if (!par) return;
  const dx = n.x - par.x, dy = n.y - par.y;
  const cx = (par.x + n.x) / 2 - dy * 0.13, cy = (par.y + n.y) / 2 + dx * 0.13;
  n.wire.setAttribute("d", `M ${par.x.toFixed(0)} ${par.y.toFixed(0)} Q ${cx.toFixed(0)} ${cy.toFixed(0)} ${n.x.toFixed(0)} ${n.y.toFixed(0)}`);
}

/* Cards stream in one at a time now, so the layout is batched: at most one
   reflow every LAYOUT_MS, and the camera only reframes when the graph has
   actually outgrown the view — not on every card, which made the whole canvas
   breathe. */
const LAYOUT_MS = 600, CAMERA_MS = 3000;   // a big board reflows about once a second and reframes rarely
let pending = null, lastLayout = 0, lastCam = 0;
/* Position is a transform, not left/top. Moving a hundred absolutely
   positioned cards by left/top re-runs layout every frame of the glide; a
   translate is handled by the compositor and touches nothing else. */
const place = (el, x, y) => { el.style.setProperty("--x", x + "px"); el.style.setProperty("--y", y + "px"); };
function fitIfNeeded() {
  if (cameraLocked) return;
  const now = performance.now();
  if (now - lastCam < CAMERA_MS) return;
  const pts = [...nodes.values()];
  if (!pts.length) return;
  const r = stage.getBoundingClientRect(), avail = r.width - drawerW(), pad = 200;
  // does everything still sit inside the frame with some margin?
  const inside = pts.every(p => {
    const sx = p.x * cam.s + cam.x, sy = p.y * cam.s + cam.y;
    return sx > pad * 0.6 && sx < avail - pad * 0.6 && sy > pad * 0.6 && sy < r.height - pad * 0.6;
  });
  if (inside && pts.length > 1) return;
  lastCam = now;
  fitAll();
}
const scheduleLayout = () => {
  if (pending) return;
  const wait = nodes.size <= 2 ? 0 : Math.max(0, LAYOUT_MS + nodes.size * 6 - (performance.now() - lastLayout));
  pending = setTimeout(() => requestAnimationFrame(() => {
    pending = null; lastLayout = performance.now();
    relayout(); fitIfNeeded();
  }), wait);
};

/* ------------------------------------------------------------------ nodes */
function addNode(d) {
  if (nodes.has(d.id)) return nodes.get(d.id);
  const n = { ...d, x: CX, y: CY };   // positioned by the next relayout
  const el = document.createElement("div");
  el.dataset.id = n.id;
  if (n.kind === "root") {
    el.className = "node root" + (running ? " thinking" : "");   // a replayed board is not working
    el.innerHTML = `<div class="seed"><div class="kicker">Prompt</div><div class="q"></div></div>`;
    el.querySelector(".q").textContent = n.title;
  } else {
    nodes.get("n0")?.el?.classList.remove("thinking");           // the first page has landed
    el.className = "node";
    el.innerHTML = `<div class="card">
        <div class="shot"><div class="ex"></div><div class="tint"></div><div class="scan"></div></div>
        <div class="meta">
          <div class="host"><i class="dot"></i><span class="h"></span></div>
          <div class="ttl"></div>
          <div class="verdict"><span class="lbl">queued</span><span class="gauge"><i></i></span><span class="pnum"></span></div>
        </div></div>
      <div class="readout"><h4>Jev · one request</h4>
        <div class="qrow" data-k="on_topic"><span>on_topic</span><b>—</b></div>
        <div class="qrow" data-k="has_primary_data"><span>primary_data</span><b>—</b></div>
        <div class="qrow" data-k="worth_expanding"><span>worth_expanding</span><b>—</b></div>
        <div class="qrow" data-k="relevance"><span>relevance</span><b>—</b></div>
        <div class="stamp">awaiting</div></div>`;
    el.querySelector(".dot").style.background = `hsl(${hueOf(n.host)} 62% 46%)`;
    el.querySelector(".tint").style.background = `hsl(${hueOf(n.host)} 70% 50%)`;
    el.querySelector(".h").textContent = n.host;
    el.querySelector(".ttl").textContent = n.title || n.host;
    el.title = n.url || "";
    makeDraggable(el, n);
  }
  world.appendChild(el); n.el = el;

  if (n.parent) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("class", "wire"); wires.appendChild(p); n.wire = p;
  }
  nodes.set(n.id, n);
  /* Not shown yet. A card fades in where the layout seats it — it does not
     glide in from wherever it happened to be created. */
  const par = nodes.get(n.parent);
  place(el, par?.x ?? CX, par?.y ?? CY);
  scheduleLayout();
  return n;
}

/* Cards can be moved. A moved card is pinned, so relayout leaves it alone and
   its wire follows it — the graph reflows around what you placed by hand. */
function makeDraggable(el, n, onClick) {
  let moved = false, startX = 0, startY = 0, ox = 0, oy = 0;
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.stopPropagation();                 // the canvas must not pan under it
    moved = false;
    startX = e.clientX; startY = e.clientY; ox = n.x; oy = n.y;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    el.style.transition = "none";
  });
  el.addEventListener("pointermove", e => {
    if (!el.classList.contains("dragging")) return;
    const dx = (e.clientX - startX) / cam.s, dy = (e.clientY - startY) / cam.s;
    if (!moved && Math.hypot(dx, dy) * cam.s < 4) return;    // a click is not a drag
    moved = true; cameraLocked = true;
    n.x = ox + dx; n.y = oy + dy;
    place(el, n.x, n.y);
    if (n.wire) setWire(n);
    for (const c of nodes.values()) if (c.parent === n.id && c.wire) setWire(c);
  });
  let lastUp = 0;
  const done = () => {
    if (!el.classList.contains("dragging")) return;
    el.classList.remove("dragging");
    el.style.transition = "";
    if (moved) { n.pinned = true; el.classList.add("pinned"); return; }
    // a second click inside the double-click window belongs to dblclick, not focus
    const now = Date.now();
    if (now - lastUp < 320) { lastUp = 0; return; }
    lastUp = now;
    (onClick || (() => focusNode(n.id)))();
  };
  el.addEventListener("pointerup", done);
  el.addEventListener("pointercancel", done);

  // double-click opens the real page
  el.addEventListener("dblclick", e => {
    e.preventDefault(); e.stopPropagation();
    if (!n.url) return;
    window.open(n.url, "_blank", "noopener,noreferrer");
  });
}

/* Single click selects and holds: a discarded card comes back to full opacity
   and keeps its Jev readout open until something else is selected. */
let selected = null;
function deselect() {
  document.querySelectorAll(".node.sel, .node.focus").forEach(e => e.classList.remove("sel", "focus"));
  selected = null;
}
function focusNode(id, { move = true } = {}) {
  const n = nodes.get(id); if (!n) return;
  if (selected === id) { deselect(); return; }      // clicking it again lets it go
  deselect();
  selected = id;
  n.el.classList.add("sel", "focus");
  if (move) { cameraLocked = true; dive(n, 1.7); }
}

function setShot(id, src) {
  const n = nodes.get(id); if (!n || !src) return;
  n.shot = src;
  const shot = n.el.querySelector(".shot"); if (!shot || shot.querySelector("img")) return;
  const img = new Image();
  img.alt = ""; img.width = 162; img.height = 96;
  img.src = src;
  // decode() resolves once the bitmap is ready, so inserting it never paints a blank frame first
  img.decode().then(() => { if (n.el.isConnected && !shot.querySelector("img")) shot.insertBefore(img, shot.querySelector(".tint")); }).catch(() => {});
}

function verdict(v) {
  const n = nodes.get(v.id); if (!n) return;
  const el = n.el;
  el.classList.remove("fetching");
  const lbl = el.querySelector(".lbl"), bar = el.querySelector(".gauge i"), num = el.querySelector(".pnum");
  if (v.title) el.querySelector(".ttl").textContent = v.title;

  if (v.error) {
    el.classList.add("dead", "gone");
    el.querySelector(".ex").innerHTML = `<span class="err">${v.error}</span>`;
    lbl.textContent = "unreachable"; num.textContent = "";
    n.wire?.setAttribute("class", "wire cut");
    return;
  }
  n.kept = v.kept; n.p = v.p;
  if (v.excerpt) el.querySelector(".ex").textContent = v.excerpt;
  el.classList.add(v.kept ? "kept" : "cut");
  if (!v.kept) el.classList.add("gone");
  lbl.textContent = v.kept ? "relevant" : "discarded";
  bar.style.width = (v.p * 100).toFixed(0) + "%";
  num.textContent = v.p.toFixed(2);
  n.wire?.setAttribute("class", "wire " + (v.kept ? "kept" : "cut"));

  for (const [k, val] of Object.entries(v.signals || {})) {
    const row = el.querySelector(`.qrow[data-k="${k}"]`); if (!row) continue;
    row.querySelector("b").textContent = Number(val).toFixed(2);
    row.classList.toggle("hi", val >= 0.62); row.classList.toggle("lo", val < 0.62);
  }
  const st = el.querySelector(".stamp");
  st.textContent = v.kept ? "keep · expand" : "discard";
  st.className = "stamp " + (v.kept ? "keep" : "drop");
}

/* ------------------------------------------------------------ convergence */
function gather(ids) {
  const seen = new Set();
  for (const id of ids) {
    let cur = nodes.get(id);
    while (cur?.parent && !seen.has(cur.id)) {
      seen.add(cur.id);
      const par = nodes.get(cur.parent); if (!par) break;
      const dx = cur.x - par.x, dy = cur.y - par.y;
      const cx = (par.x + cur.x) / 2 - dy * 0.13, cy = (par.y + cur.y) / 2 + dx * 0.13;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", `M ${cur.x.toFixed(0)} ${cur.y.toFixed(0)} Q ${cx.toFixed(0)} ${cy.toFixed(0)} ${par.x.toFixed(0)} ${par.y.toFixed(0)}`);
      p.setAttribute("class", "wire pulse");
      const L = Math.hypot(dx, dy) * 1.12;
      p.style.setProperty("--len", L.toFixed(0));
      p.style.strokeDasharray = `14 ${L.toFixed(0)}`;
      p.style.animationDelay = `-${(Math.random() * 1.25).toFixed(2)}s`;
      wires.appendChild(p);
      cur = par;
    }
  }
}
function showReportBlock(headline, count) {
  nodes.get("n0")?.el.classList.remove("in");
  let el = nodes.get("__report")?.el;
  if (!el) {
    el = document.createElement("div");
    el.className = "node laya";
    el.innerHTML = `<div class="seed"><div class="kicker"><span class="c"></span> sources</div>
      <div class="q"></div><div class="open">Open report <i data-lucide="arrow-right"></i></div></div>`;
    world.appendChild(el); icons();
    const rn = { id: "__report", x: CX, y: CY, el, depth: 0 };
    nodes.set("__report", rn);
    makeDraggable(el, rn, openDrawer);
  }
  place(el, CX, CY);
  el.querySelector(".c").textContent = count;
  el.querySelector(".q").textContent = headline;
  let glow = world.querySelector(".glow");
  if (!glow) { glow = document.createElement("div"); glow.className = "glow"; world.insertBefore(glow, world.firstChild); }
  place(glow, CX, CY);
  requestAnimationFrame(() => { el.classList.add("in", "pulsing"); glow.classList.add("on"); });
  setTimeout(() => {
    el.classList.remove("pulsing");
    wires.querySelectorAll(".pulse").forEach(p => p.remove());
    world.classList.add("converged");
  }, 1400);
}

/* ----------------------------------------------------------------- report */
let lastReport = null;

/* A small markdown renderer — enough for what the report actually contains:
   headings, paragraphs, lists, tables, inline code, links and [n] citations. */
function mdToHtml(src, byN) {
  const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = t => esc(t)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, ns) => ns.split(/\s*,\s*/).map(x => {
      const s = byN.get(+x);
      return s ? `<cite data-n="${s.id}" title="${s.host}">${x}</cite>` : `<cite>${x}</cite>`;
    }).join(""));

  const lines = src.replace(/\r/g, "").split("\n");
  const out = []; let i = 0, guard = 0;
  // Nothing in a renderer is worth hanging a tab for.
  while (i < lines.length && guard++ < lines.length * 4) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h2>${inline(h[2])}</h2>`); i++; continue; }

    /* Tables. While streaming, a header row arrives BEFORE its separator, so a
       run of pipe lines with no separator yet is rendered as a header-only
       table rather than falling through — which used to hit the paragraph
       branch, match nothing, never advance `i`, and hang the tab. */
    if (/^\s*\|/.test(l)) {
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const sep = /^\s*\|?[-:\s|]+\|/.test(lines[i + 1] || "");
      const head = cells(l);
      i += sep ? 2 : 1;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (/^\s*\|?[-:\s|]+\|?\s*$/.test(lines[i])) { i++; continue; }   // a separator arriving late
        body.push(cells(lines[i++]));
      }
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]))
        items.push(`<li>${inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*+]|\d+\.)\s)/.test(lines[i]))
      para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);   // never leave `i` where it was
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("");
}

/* ------------------------------------------------------- streaming report
   The skeleton appears the moment the outline exists, then each section fills
   in. Markdown is re-rendered per section on every flush — cheap at this size,
   and it means tables and lists resolve as soon as their syntax closes rather
   than snapping in at the end. */
let streamBuf = [], streamSrc = null;

function beginReport(b) {
  streamBuf = b.headings.map(() => "");
  streamSrc = new Map(b.sources.map(s => [s.n, s]));
  lastReport = null;
  $("rhead").textContent = b.headline;
  $("rkick").textContent = `Synthesis · ${b.sources.length} sources`;
  // Each heading is revealed when its own section starts writing — showing all
  // of them up front reads as though they were decided in advance.
  $("report").innerHTML = b.headings.map((h, i) =>
    `<div class="blk up sec" data-i="${i}" ${i ? "hidden" : ""}><h2>${escapeHtml(h)}</h2><div class="secbody"></div></div>`).join("");
  $("report").querySelector('.sec[data-i="0"]')?.classList.add("writing");
  follow = true; dirty.clear();
  openDrawer();
}

/* Render is rAF-batched: tokens land in a buffer, and at most one markdown
   parse per section happens per frame no matter how fast they arrive. Writing
   to the DOM on every token re-parsed a growing string thousands of times,
   which is what took the tab down. */
let dirty = new Set(), raf = null, follow = true;

function paint() {
  raf = null;
  const box = $("report");
  for (const i of dirty) {
    const el = box.querySelector(`.sec[data-i="${i}"]`);
    if (el) el.querySelector(".secbody").innerHTML = mdToHtml(streamBuf[i], streamSrc || new Map());
  }
  dirty.clear();
  if (follow) box.scrollTop = box.scrollHeight;
}

function streamToken(t) {
  if (!streamBuf.length) return;
  const box = $("report");
  if (t.text != null) {
    if (streamBuf[t.i] === undefined) streamBuf[t.i] = "";
    streamBuf[t.i] += t.text;
    const el = box.querySelector(`.sec[data-i="${t.i}"]`);
    if (el && el.hidden) { el.hidden = false; el.classList.add("writing"); }
    dirty.add(t.i);
    if (!raf) raf = requestAnimationFrame(paint);
    return;
  }
  if (t.done) {
    dirty.add(t.i);
    if (!raf) raf = requestAnimationFrame(paint);
    box.querySelector(`.sec[data-i="${t.i}"]`)?.classList.remove("writing");
  }
}

function renderReport(r) {
  lastReport = r;
  $("rhead").textContent = r.headline;
  $("rkick").textContent = `Synthesis · ${r.sources.length} sources · $${(r.stats.cost || 0).toFixed(4)}`;
  const byN = new Map(r.sources.map(s => [s.n, s]));

  const srcs = r.sources.map(s =>
    `<div class="src" data-n="${s.id}"><span>${s.n}</span><span class="u">${s.host}</span><span>${s.p.toFixed(2)}</span></div>`).join("");

  streamBuf = [];
  $("report").innerHTML =
    `<div class="blk up">${mdToHtml(r.markdown || "", byN)}</div>` +
    `<div class="blk"><h3>References</h3><div class="sources">${srcs}</div>
      <div class="runstats">${r.stats.fetched} fetched · ${r.stats.kept} kept · ${r.stats.cut} cut · ${r.stats.failed} unreachable<br>
      ${r.stats.jevCalls} ${r.stats.jev} calls · ${(r.stats.jevMs / Math.max(1, r.stats.jevCalls)).toFixed(0)} ms avg<br>
      ${r.stats.model.split("/").pop()} $${(r.stats.llmCost || 0).toFixed(4)} · jev $${(r.stats.jevCost || 0).toFixed(4)} · total $${(r.stats.cost || 0).toFixed(4)}</div></div>`;

  [...$("report").querySelectorAll(".blk")].forEach(b => b.classList.add("up"));
  $("report").querySelector("p")?.classList.add("lede");
}

$("report").addEventListener("scroll", () => {
  const box = $("report");
  follow = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}, { passive: true });
$("report").addEventListener("mouseover", e => { const t = e.target.closest("[data-n]"); if (t) nodes.get(t.dataset.n)?.el?.classList.add("flash"); });
$("report").addEventListener("mouseout", e => { const t = e.target.closest("[data-n]"); if (t) nodes.get(t.dataset.n)?.el?.classList.remove("flash"); });
$("report").addEventListener("click", e => { const t = e.target.closest("[data-n]"); if (t) { deselect(); focusNode(t.dataset.n); } });

/* ------------------------------------------------------------------ chrome */
function showStats(d) {
  $("g-fetch").textContent = d.fetched;
  $("g-keep").textContent = d.want ? `${d.kept}/${d.want}` : d.kept;
  $("g-cut").textContent = d.cut;
  if (d.wave != null) $("g-wave").textContent = d.wave;
  if (d.want != null) $("g-want").textContent = d.want;
  $("g-cost").textContent = "$" + (d.cost || 0).toFixed(3);
  $("costsplit").textContent = `llm $${(d.llmCost || 0).toFixed(4)} · jev $${(d.jevCost || 0).toFixed(4)}`;
}
function setPhase(text, state) {
  $("phase").textContent = text;
  $("led").className = "led" + (state ? " " + state : "");
  $("phasebtn").title = text;            // readable while collapsed
}
function log(text, bad) {
  const d = document.createElement("div");
  d.textContent = text; if (bad) d.className = "bad";
  $("log").prepend(d);
  while ($("log").children.length > 5) $("log").lastChild.remove();
}
function openDrawer() {
  $("drawer").classList.add("open");
  document.documentElement.style.setProperty("--drawer-w", (innerWidth > 760 ? $("drawer").offsetWidth : 0) + "px");
}
$("shut").onclick = () => { $("drawer").classList.remove("open"); document.documentElement.style.setProperty("--drawer-w", "0px"); };
$("pdf").onclick = () => window.print();
$("copymd").onclick = async () => {
  if (!lastReport?.full) return;
  try {
    await navigator.clipboard.writeText(lastReport.full);
    const b = $("copymd");
    b.classList.add("ok"); b.title = "Copied";
    setTimeout(() => { b.classList.remove("ok"); b.title = "Copy markdown"; }, 1400);
  } catch { log("clipboard blocked — select the text instead", true); }
};
/* The fit button is gone — double-clicking empty canvas re-frames instead. */
stage.addEventListener("dblclick", e => {
  if (e.target.closest(".node")) return;
  cameraLocked = false; fitAll();
});

/* The status card collapses to just its light. Open by default; the choice sticks. */
const telem = $("telemetry");
if (store.get("sl-panel") === "0") telem.classList.remove("open");
$("phasebtn").setAttribute("aria-expanded", String(telem.classList.contains("open")));
$("phasebtn").onclick = () => {
  const open = telem.classList.toggle("open");
  $("phasebtn").setAttribute("aria-expanded", String(open));
  store.set("sl-panel", open ? "1" : "0");
};

const drawer = $("drawer"), grip = $("grip");
const savedW = parseInt(store.get("sl-drawer") || "470", 10);
drawer.style.width = (isNaN(savedW) ? 470 : savedW) + "px";
let sizing = false;
const setW = px => {
  const w = Math.max(320, Math.min(px, Math.min(920, innerWidth - 120)));
  drawer.style.width = w + "px";
  document.documentElement.style.setProperty("--drawer-w", (innerWidth > 760 ? w : 0) + "px");
  store.set("sl-drawer", String(w));
};
grip.addEventListener("pointerdown", e => { sizing = true; drawer.classList.add("sizing"); grip.setPointerCapture(e.pointerId); e.preventDefault(); });
grip.addEventListener("pointermove", e => { if (sizing) setW(innerWidth - e.clientX); });
const endSize = () => { sizing = false; drawer.classList.remove("sizing"); };
grip.addEventListener("pointerup", endSize); grip.addEventListener("pointercancel", endSize);

const pop = $("pop"), plus = $("plus"), slider = $("depth"), dock = document.querySelector(".dock"), prompt = $("prompt");

/* The prompt grows with what is typed: one line as a pill, then the buttons
   move under the text, up to eight lines, then it scrolls. */
const MAX_ROWS = 8;
const promptRows = () => {
  prompt.style.height = "auto";
  const line = parseFloat(getComputedStyle(prompt).lineHeight) || 20;
  const cs = getComputedStyle(prompt);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  return { line, pad, rows: Math.max(1, Math.round((prompt.scrollHeight - pad) / line)) };
};
const runBtn = $("run");
const FLIP_MS = 240, EASE = "cubic-bezier(.4,0,.2,1)";
function fitPrompt() {
  const wasTall = dock.classList.contains("tall");
  const first = [prompt, plus, runBtn].map(e => e.getBoundingClientRect());
  const firstH = dock.offsetHeight;

  /* Decide the layout from how the text fits in the PILL, where the buttons
     share the row and the text is narrowest. Deciding from the wide layout
     would flip back and forth at the boundary. */
  dock.classList.add("snap");
  dock.classList.remove("tall");
  const tall = promptRows().rows > 1;
  dock.classList.toggle("tall", tall);
  const { line, pad, rows } = promptRows();
  prompt.style.height = (Math.min(rows, MAX_ROWS) * line + pad) + "px";
  prompt.classList.toggle("scroll", rows > MAX_ROWS);

  if (tall === wasTall) {
    // same layout, only the height changed: let the CSS transition carry it
    void dock.offsetHeight; dock.classList.remove("snap");
  } else {
    /* The layout itself changed. Everything is already in its final place;
       put each piece back where it was and let it glide to where it is now,
       while the dock's box grows or shrinks over the same beat. */
    const last = [prompt, plus, runBtn].map(e => e.getBoundingClientRect());
    [prompt, plus, runBtn].forEach((e, i) => {
      e.style.transition = "none";
      e.style.transform = `translate(${first[i].left - last[i].left}px,${first[i].top - last[i].top}px)`;
    });
    const lastH = dock.offsetHeight;
    dock.style.height = firstH + "px"; dock.style.overflow = "hidden";
    void dock.offsetHeight;                          // commit the "before" frame
    dock.classList.remove("snap");
    [prompt, plus, runBtn].forEach(e => { e.style.transition = `transform ${FLIP_MS}ms ${EASE}`; e.style.transform = ""; });
    dock.classList.add("flipping");
    dock.style.height = lastH + "px";
    setTimeout(() => {
      dock.style.height = ""; dock.style.overflow = ""; dock.classList.remove("flipping");
      [prompt, plus, runBtn].forEach(e => { e.style.transition = ""; });
    }, FLIP_MS + 20);
  }
  if (pop.classList.contains("open")) placePop();
}
prompt.addEventListener("input", fitPrompt);
addEventListener("resize", fitPrompt);
const placePop = () => {
  const r = plus.getBoundingClientRect(), d = dock.getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(r.left, innerWidth - 302)) + "px";
  pop.style.bottom = (innerHeight - d.top + 10) + "px";     // sits above the dock however tall it is
};
plus.onclick = e => { e.stopPropagation(); const o = pop.classList.toggle("open"); plus.setAttribute("aria-expanded", String(o)); if (o) placePop(); };
document.addEventListener("click", e => { if (!pop.contains(e.target) && e.target !== plus) { pop.classList.remove("open"); plus.setAttribute("aria-expanded", "false"); } });
const srcSlider = $("minsrc");
function setDepth(v, remember = true) {
  maxDepth = +v;
  slider.value = v; $("dval").textContent = v; $("g-depth").textContent = v;
  if (remember) store.set("sl-depth", String(v));
}
function setMinSources(v, remember = true) {
  minSources = +v;
  srcSlider.value = v; $("sval").textContent = v; $("g-want").textContent = v;
  if (remember) store.set("sl-minsrc", String(v));
}
slider.oninput = () => setDepth(slider.value);
srcSlider.oninput = () => setMinSources(srcSlider.value);

/* Whatever was chosen last time wins over the server's defaults. */
const storedDepth = parseInt(store.get("sl-depth") || "", 10);
const storedSrc = parseInt(store.get("sl-minsrc") || "", 10);
if (storedDepth >= 1 && storedDepth <= 50) setDepth(storedDepth, false);
if (storedSrc >= 1 && storedSrc <= 50) setMinSources(storedSrc, false);

/* --------------------------------------------------------------- the run */
function clearCanvas() {
  selected = null;
  for (const n of nodes.values()) n.el?.remove();
  nodes.clear(); wires.innerHTML = ""; world.querySelector(".glow")?.remove();
  world.classList.remove("converged");
  $("g-fetch").textContent = $("g-keep").textContent = $("g-cut").textContent = "0";
  $("log").innerHTML = "";
  $("report").innerHTML = ""; streamBuf = []; streamSrc = null; dirty.clear(); follow = true;
  drawer.classList.remove("open");
  document.documentElement.style.setProperty("--drawer-w", "0px");
}
function newChat({ url = true } = {}) {
  if (es) { es.close(); es = null; }
  if (runId) fetch(`/api/run/${runId}/stop`, { method: "POST" }).catch(() => {});
  running = false; runId = null; $("run").classList.remove("busy");
  clearCanvas(); cameraLocked = false;
  if (url) setBoardUrl(null, true);
  $("prompt").value = ""; fitPrompt(); setPhase("Ready", "");
  $("empty").classList.add("on");
  pop.classList.remove("open"); plus.setAttribute("aria-expanded", "false");
  frame([{ x: CX, y: CY }], 640, 1);
  $("prompt").focus();
}
$("newchat").onclick = () => newChat();

async function start() {
  if (running) {                                  // the submit button doubles as stop
    if (runId) await fetch(`/api/run/${runId}/stop`, { method: "POST" }).catch(() => {});
    return;
  }
  const goal = $("prompt").value.trim();
  if (!goal) { $("prompt").focus(); return; }

  clearCanvas(); cameraLocked = false;
  $("empty").classList.remove("on");
  running = true; $("run").classList.add("busy");
  setPhase("Starting", "live");

  let res;
  try {
    res = await (await fetch("/api/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal, depth: maxDepth, minSources }),
    })).json();
  } catch (e) { setPhase("Server unreachable", "bad"); running = false; $("run").classList.remove("busy"); return; }
  if (res.error) { setPhase(res.error, "bad"); log(res.error, true); running = false; $("run").classList.remove("busy"); return; }

  runId = res.id;
  prompt.value = ""; fitPrompt();                    // the question is on the canvas now
  setBoardUrl(res.id, true);
  listen(runId);
}

function listen(id) {
  es = new EventSource(`/api/run/${id}/events`);
  const on = (t, fn) => es.addEventListener(t, e => fn(JSON.parse(e.data)));

  on("phase", d => setPhase(d.text, d.state));
  on("plan", d => {
    log(d.wave > 1 ? `wave ${d.wave}: ${d.queries.length} new queries` : `${d.queries.length} queries planned`);
    d.queries.slice(0, 4).forEach(q => log("? " + q));
  });
  on("node", d => addNode(d));
  on("node:state", d => nodes.get(d.id)?.el.classList.add(d.state));
  on("node:verdict", d => verdict(d));
  on("node:drop", d => {                            // read too late to matter; take it off the board
    const n = nodes.get(d.id); if (!n) return;
    n.el?.remove(); n.wire?.remove(); nodes.delete(d.id); scheduleLayout();
  });
  on("node:shot", d => setShot(d.id, d.src));
  on("stats", d => showStats(d));
  on("engines", d => {
    if (d.answered?.length) log("search via " + d.answered.join(", "));
    if (d.unresponsive?.length) log(d.unresponsive.length + " engines blocked: " + d.unresponsive.map(u => u.engine).join(", "), true);
  });
  on("log", d => log(d.text));
  on("warn", d => log(d.text, true));
  on("error", d => { setPhase(d.text, "bad"); log(d.text, true); nodes.get("n0")?.el?.classList.remove("thinking"); });
  on("gather", d => { if (!cameraLocked) fitAll(); gather(d.ids); });
  on("report:begin", d => beginReport(d));
  on("report:token", d => streamToken(d));
  on("report", d => { renderReport(d); showReportBlock(d.headline, d.sources.length); openDrawer(); });
  on("end", () => { running = false; nodes.get("n0")?.el?.classList.remove("thinking"); $("run").classList.remove("busy"); es.close(); es = null; refreshHistory(); });
  es.onerror = () => { if (running) { setPhase("Connection lost", "bad"); running = false; $("run").classList.remove("busy"); } };
}
$("run").onclick = start;
// Enter sends; Shift+Enter is a new line.
prompt.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } });

addEventListener("resize", () => {
  document.documentElement.style.setProperty("--drawer-w", (drawer.classList.contains("open") && innerWidth > 760 ? drawer.offsetWidth : 0) + "px");
  if (!cameraLocked) fitAll();
  if (pop.classList.contains("open")) placePop();
});

/* Health check tells the dock what the server is actually configured with. */
fetch("/api/health").then(r => r.json()).then(h => {
  $("thr").textContent = h.threshold; $("cap").textContent = h.maxPages; $("wav").textContent = h.maxWaves;
  // only adopt the server default when nothing was chosen here before
  if (h.minSources && !(storedSrc >= 1)) setMinSources(h.minSources, false);
  if (!h.ok) { setPhase(`missing ${h.missing.join(", ")}`, "bad"); log("check .env", true); }
}).catch(() => setPhase("Server unreachable", "bad"));

frame([{ x: CX, y: CY }], 640, 1);
icons();

/* ------------------------------------------------------------------- links
   Every board has its own URL: /r/<runId>. Opening one cold loads it from
   history; if the run is still going, the page reattaches to the live stream
   and replays everything it missed. */
const boardPath = id => `/r/${id}`;
const idFromUrl = () => (/^\/r\/([\w-]+)/.exec(location.pathname) || [])[1] || null;

function setBoardUrl(id, push = false) {
  const path = id ? boardPath(id) : "/";
  if (location.pathname === path) return;
  history[push ? "pushState" : "replaceState"]({ id }, "", path);
}

/** Attach to a run that is still in flight (after a reload mid-crawl). */
function attach(id) {
  runId = id; running = true; $("run").classList.add("busy");
  $("empty").classList.remove("on");
  setPhase("Reattaching", "live");
  listen(id);
}

async function openFromUrl() {
  const id = idFromUrl();
  if (!id) { return false; }
  const saved = await fetch(`/api/runs/${id}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (saved && !saved.error) { await openRun(id, { url: false }); return true; }
  // not saved yet — it may still be running
  const alive = await fetch(`/api/run/${id}/status`).then(r => r.json()).then(j => j.alive).catch(() => false);
  if (alive) { clearCanvas(); attach(id); return true; }
  setPhase("That board is gone", "bad");
  setBoardUrl(null);
  return false;
}

addEventListener("popstate", () => {
  const id = idFromUrl();
  if (!id) { newChat({ url: false }); return; }
  if (id !== runId) openRun(id, { url: false });
});

/* ---------------------------------------------------------------- history
   A finished run is saved whole on the server, so reopening one rebuilds the
   canvas and the report from disk — no fetching, no model calls, no cost. */
const hist = $("hist");
async function refreshHistory() {
  let rows = [];
  try { rows = await (await fetch("/api/runs")).json(); } catch { /* server down */ }
  if (!rows.length) {
    $("hlist").innerHTML = `<div class="hempty">No runs yet. Ask something and it will be saved here when it finishes.</div>`;
    return;
  }
  $("hlist").innerHTML = rows.map(r => {
    const when = new Date(r.at);
    const ago = (() => {
      const m = Math.round((Date.now() - when) / 60000);
      if (m < 1) return "just now";
      if (m < 60) return m + "m ago";
      if (m < 1440) return Math.round(m / 60) + "h ago";
      return Math.round(m / 1440) + "d ago";
    })();
    return `<div class="hrow${r.id === runId ? " on" : ""}" data-r="${r.id}">
      <div class="hacts">
        <button class="hic" data-link="${r.id}" title="Copy link" aria-label="Copy link to this board">
          <i data-lucide="link"></i></button>
        <button class="hic" data-del="${r.id}" title="Delete" aria-label="Delete run">
          <i data-lucide="trash-2"></i></button>
      </div>
      <div class="g">${escapeHtml(r.goal)}</div>
      ${r.headline ? `<div class="h">${escapeHtml(r.headline)}</div>` : ""}
      <div class="m"><span>${ago}</span><span>depth ${r.depth}</span>
        <span>${r.kept}/${r.fetched} kept</span><b>$${(r.cost || 0).toFixed(3)}</b>
        ${r.stopped ? "<span>stopped</span>" : ""}</div></div>`;
  }).join("");
  icons();
}
const escapeHtml = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rebuild a whole canvas from a saved run. */
async function openRun(id, { url = true } = {}) {
  let r;
  try { r = await (await fetch(`/api/runs/${id}`)).json(); } catch { return; }
  if (!r || r.error) return;

  if (es) { es.close(); es = null; }
  running = false; $("run").classList.remove("busy");
  clearCanvas(); cameraLocked = false;
  $("empty").classList.remove("on");
  runId = r.id;
  if (url) setBoardUrl(r.id, true);
  $("prompt").value = r.goal; fitPrompt();
  setDepth(r.depth, false);
  if (r.minSources) setMinSources(r.minSources, false);

  for (const n of r.nodes) {
    addNode({ id: n.id, parent: n.parent, depth: n.depth, kind: n.kind, url: n.url, host: n.host, title: n.title });
    if (n.kind === "root") continue;
    verdict({ id: n.id, kept: n.kept, p: n.p ?? 0, signals: n.signals, error: n.error, title: n.title, excerpt: n.excerpt });
    if (n.shot) setShot(n.id, n.shot);
  }
  showStats(r.stats);
  setPhase(r.stopped ? "Stopped · restored" : "Run complete", r.stopped ? "" : "done");
  log(`restored ${r.nodes.length} cards`);

  if (r.report) {
    renderReport(r.report);
    requestAnimationFrame(() => {
      relayout(); fitAll();
      gather(r.report.sources.map(s => s.id));
      showReportBlock(r.report.headline, r.report.sources.length);
      setTimeout(openDrawer, 600);
    });
  } else {
    requestAnimationFrame(() => { relayout(); fitAll(); });
  }
  refreshHistory();
}

$("histbtn").onclick = async () => { await refreshHistory(); hist.classList.add("open"); };
$("hclose").onclick = () => hist.classList.remove("open");
$("hlist").addEventListener("click", async e => {
  const link = e.target.closest("[data-link]");
  if (link) {
    e.stopPropagation();
    const url = location.origin + boardPath(link.dataset.link);
    try {
      await navigator.clipboard.writeText(url);
      link.classList.add("ok"); link.title = "Copied";
      setTimeout(() => { link.classList.remove("ok"); link.title = "Copy link"; }, 1300);
    } catch { log(url); }
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    await fetch(`/api/runs/${del.dataset.del}`, { method: "DELETE" }).catch(() => {});
    refreshHistory();
    return;
  }
  const row = e.target.closest("[data-r]");
  if (row) { hist.classList.remove("open"); openRun(row.dataset.r); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") hist.classList.remove("open"); });

refreshHistory();

/* Bootstrap last: openFromUrl() reads consts defined further up this file, and
   calling it earlier left it in the temporal dead zone — a rejected promise
   that silently broke deep links on load. */
openFromUrl()
  .then(opened => { if (!opened) $("prompt").focus(); })
  .catch(e => { console.error(e); $("prompt").focus(); });
