// Assemble the FULL board from the torus-routed stamp -- the hybrid:
//
//   phase 1  PATTERN   lay the stamp's paths on every quad, but only the ones
//                      that are legal and anchored THERE. Interior quads take
//                      all of them. At the rim a path that leaves the board,
//                      lands on a nudged part, or hangs off a ladder that does
//                      not exist is dropped whole (and so is anything that
//                      hung off it) -- never trimmed into a stub.
//   phase 2  PATCH     for every quad, ask what its pins still need (register
//                      -> bridge, bridge -> coil terminal, pads -> bus lanes,
//                      lane row -> lane row) and route exactly that in a window
//                      of the real board, against everything already laid.
//
// Everything lives on ONE board-wide grid that the stamp's own grid is a
// period of, so a patterned path is the same list of nodes the router would
// have produced and the legality test is the router's own.
//
//   node assemble.mjs <bareKey> <stamp.paths.json> <outKey>
//   env: ONLY=<quad,quad>  patch only these quads      SKIP_PATCH=1  phase 1 only
//        EXTRA=<file.json> more connection jobs (board-level nets), see below
import { readFileSync, writeFileSync } from 'fs';
import { GridRouter, RULE } from './gridrouter.mjs';
import { makeStator } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize } from '../src/kicad.js';

const B = process.argv[2], DUMP = process.argv[3], OUT = process.argv[4];
const spec = JSON.parse(readFileSync(`${B}.quads.json`, 'utf8'));
const { quads } = spec;
const stamp = JSON.parse(readFileSync(DUMP, 'utf8'));
const G = stamp.grid;
const txt = readFileSync(`${B}.kicad_pcb`, 'utf8');
const T0 = Date.now();
const el = () => `${((Date.now() - T0) / 1000).toFixed(0)}s`;

// ---- board ---------------------------------------------------------------------
const netName = new Map(), netNum = new Map();
for (const m of txt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) { netName.set(+m[1], m[2]); netNum.set(m[2], +m[1]); }
const outline = [];
for (const m of txt.matchAll(/\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)/g)) outline.push([+m[1], +m[2], +m[3], +m[4]]);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [a, b, c, d] of outline) { minX = Math.min(minX, a, c); maxX = Math.max(maxX, a, c); minY = Math.min(minY, b, d); maxY = Math.max(maxY, b, d); }
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const coilF = stator.coils.map((c) => [(minX + maxX) / 2 + c.x * 1000, (minY + maxY) / 2 - c.y * 1000]);
const pitch = cfg.stator.coilPitch * 1000;
const gPlan = pcbCoilGeometry(cfg);
const termOff = viaPlan(gPlan, gPlan.layers, pitch / 2, viaSize(gPlan, pitch / 2), spec.viaPlanOpts || {}).termVias.map((t) => t.p);
const quadOfCell = new Map();
quads.forEach((q, g) => q.cells.forEach((c, k) => quadOfCell.set(c, { g, k })));
const Qc = quads[G.centreQuad];

const LAYERS = ['B.Cu', 'In12.Cu', 'In11.Cu', 'In10.Cu', 'In9.Cu', 'In8.Cu', 'In7.Cu', 'In6.Cu', 'In5.Cu', 'In4.Cu', 'In3.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu'];
const LI = new Map(LAYERS.map((l, k) => [l, k]));
const BUS = ['GND', 'VBUS', 'VLOGIC', 'SCLK', 'RCLK', 'OE_N', 'SDA', 'SCL'];

const vias = [];
for (const m of txt.matchAll(/^  \(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill ([\d.]+)\) \(layers "[^"]+" "[^"]+"\) \(net (\d+)\)\)/gm)) {
  vias.push({ x: +m[1], y: +m[2], r: +m[3] / 2, net: netName.get(+m[5]) });
}
const fps = [];
for (const m of txt.matchAll(/  \(footprint "maglev:([^"]+)" \(layer "([^"]+)"\) \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)([\s\S]*?)\n  \)\n/g)) {
  if (m[5] && +m[5] !== 0) throw new Error('rotated footprint');
  const ref = (m[6].match(/\(fp_text reference "([^"]+)"/) || [])[1];
  const pads = [];
  for (const p of m[6].matchAll(/\(pad "([^"]+)" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\) \(layers "([^"]+)"[^)]*\)(?: \(clearance [\d.]+\))? \(net (\d+) "([^"]*)"\)\)/g)) {
    pads.push({ ref, name: p[1], x: +m[3] + +p[2], y: +m[4] + +p[3], deg: +(p[4] || 0), w: +p[5], h: +p[6], net: p[9] });
  }
  fps.push({ ref, x: +m[3], y: +m[4], pads });
}
const fpByRef = new Map(fps.map((f) => [f.ref, f]));
// winding copper: [ax, ay, bx, by, halfwidth, layer] (segments) and arcs kept whole
const wseg = [], warc = [];
for (const m of txt.matchAll(/^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "([^"]+)"\) \(net (\d+)\)\)/gm)) {
  if (!/^coil_/.test(netName.get(+m[7]))) throw new Error(`bare board carries routed copper on ${netName.get(+m[7])}`);
  wseg.push(+m[1], +m[2], +m[3], +m[4], +m[5] / 2, LI.get(m[6]));
}
for (const m of txt.matchAll(/^  \(arc \(start ([-\d.]+) ([-\d.]+)\) \(mid ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "([^"]+)"\) \(net (\d+)\)\)/gm)) {
  warc.push(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +m[7] / 2, LI.get(m[8]));
}
const arcPts = (sx, sy, mx, my, ex, ey) => {
  const d = 2 * (sx * (my - ey) + mx * (ey - sy) + ex * (sy - my));
  if (Math.abs(d) < 1e-12) return [[sx, sy], [ex, ey]];
  const ux = ((sx * sx + sy * sy) * (my - ey) + (mx * mx + my * my) * (ey - sy) + (ex * ex + ey * ey) * (sy - my)) / d;
  const uy = ((sx * sx + sy * sy) * (ex - mx) + (mx * mx + my * my) * (sx - ex) + (ex * ex + ey * ey) * (mx - sx)) / d;
  const r = Math.hypot(sx - ux, sy - uy);
  const a0 = Math.atan2(sy - uy, sx - ux), a1 = Math.atan2(my - uy, mx - ux), a2 = Math.atan2(ey - uy, ex - ux);
  const norm = (a) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
  const sweep = norm(a1 - a0) < norm(a2 - a0) ? norm(a2 - a0) : -norm(a0 - a2);
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - 0.0005 / r)))));
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push([ux + r * Math.cos(a0 + (sweep * k) / n), uy + r * Math.sin(a0 + (sweep * k) / n)]);
  return pts;
};
console.log(`board: ${vias.length} vias, ${fps.length} parts, ${wseg.length / 6} winding segments, ${warc.length / 8} arcs  (${el()})`);

// ---- the board-wide grid -----------------------------------------------------------
const { hx, hy } = G;
const gI = (x) => Math.round((x - G.x0) / hx), gJ = (y) => Math.round((y - G.y0) / hy);
const gX = (I) => G.x0 + I * hx, gY = (J) => G.y0 + J * hy;
const OFF = 4096, GW = 16384;                       // global key packing
const gkey = (l, I, J) => (l * GW + (J + OFF)) * GW + (I + OFF);
const quadShift = (g) => [(quads[g].pos - Qc.pos) * G.nx, -(quads[g].band - Qc.band) * G.ny];

// class key of a board item: the unit that may touch itself
const termKind = (cell, x, y) => {
  const [cx, cy] = coilF[cell];
  if (Math.hypot(x - cx - termOff[0][0], y - cy - termOff[0][1]) < 0.05) return 'A';
  if (Math.hypot(x - cx - termOff[1][0], y - cy - termOff[1][1]) < 0.05) return 'B';
  return null;
};
const viaClass = (v) => {
  const m = /^coil_(\d+)$/.exec(v.net);
  if (!m) return v.net;
  const k = termKind(+m[1], v.x, v.y);
  return k ? `coil${k}_${m[1]}` : null;             // null = winding crossover: closed to all
};
const padClass = (p) => {
  const m = /^coil_(\d+)$/.exec(p.net);
  return m ? `coil${p.name === '2' ? 'A' : 'B'}_${m[1]}` : p.net;
};
const classNet = (c) => { const m = /^coil[AB]_(\d+)$/.exec(c); return m ? `coil_${m[1]}` : c; };

// ---- elements + connectivity (same-class copper sharing a grid node) ----------------
const elements = [];                               // {cls, kind, nodes:[l,I,J...], via?, bbox, tag}
const nodeOwner = new Map();                       // cls -> Map(gkey -> element id)
const uf = [];
const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
// rip-up: mark elements dead, then rebuild the node map and the union-find
// from what is left (connectivity cannot be un-merged in place)
const rebuild = () => {
  nodeOwner.clear();
  for (const e of elements) uf[e.id] = e.id;
  for (const e of elements) {
    if (e.dead) continue;
    if (!nodeOwner.has(e.cls)) nodeOwner.set(e.cls, new Map());
    const M = nodeOwner.get(e.cls), n = e.nodes;
    for (let k = 0; k < n.length; k += 3) {
      const key = gkey(n[k], n[k + 1], n[k + 2]), o = M.get(key);
      if (o === undefined) M.set(key, e.id); else { const a = find(o), b = find(e.id); if (a !== b) uf[b] = a; }
    }
  }
};
const addElement = (e) => {
  const id = elements.length; elements.push(e); uf.push(id);
  if (!nodeOwner.has(e.cls)) nodeOwner.set(e.cls, new Map());
  const M = nodeOwner.get(e.cls), n = e.nodes;
  let i0 = 1e9, i1 = -1e9, j0 = 1e9, j1 = -1e9;
  for (let k = 0; k < n.length; k += 3) {
    const key = gkey(n[k], n[k + 1], n[k + 2]);
    const o = M.get(key);
    if (o === undefined) M.set(key, id); else { const a = find(o), b = find(id); if (a !== b) uf[b] = a; }
    if (n[k + 1] < i0) i0 = n[k + 1]; if (n[k + 1] > i1) i1 = n[k + 1]; if (n[k + 2] < j0) j0 = n[k + 2]; if (n[k + 2] > j1) j1 = n[k + 2];
  }
  e.bbox = [i0, j0, i1, j1]; e.id = id;
  return id;
};
const padCells = (p) => {
  const out = [], a = (p.deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const w = p.w / 2 - 0.03, h = p.h / 2 - 0.03, Rr = Math.hypot(p.w, p.h) / 2;
  for (let J = gJ(p.y - Rr); J <= gJ(p.y + Rr); J++) for (let I = gI(p.x - Rr); I <= gI(p.x + Rr); I++) {
    const dx = gX(I) - p.x, dy = gY(J) - p.y;
    if (Math.abs(dx * ca - dy * sa) <= w && Math.abs(dx * sa + dy * ca) <= h) out.push(0, I, J);
  }
  if (!out.length) throw new Error(`pad ${p.ref}.${p.name} holds no grid node`);
  return out;
};
const padEl = new Map();                           // 'ref.name' -> element id
for (const fp of fps) for (const p of fp.pads) {
  if (!p.net) continue;
  padEl.set(`${fp.ref}.${p.name}`, addElement({ cls: padClass(p), kind: 'pad', nodes: padCells(p), pad: p }));
}
const viaAt = new Map();                           // 'I,J' -> via (pin barrels only)
const viaEl = new Map();
for (const v of vias) {
  const cls = viaClass(v);
  if (!cls) continue;
  const I = gI(v.x), J = gJ(v.y), nodes = [];
  for (let l = 0; l < LAYERS.length; l++) nodes.push(l, I, J);
  viaAt.set(`${I},${J}`, v);
  viaEl.set(v, addElement({ cls, kind: 'via', nodes, via0: v }));
}
const boardVia = (net, x, y, tol = 0.03) => vias.find((v) => v.net === net && Math.hypot(v.x - x, v.y - y) < tol);
console.log(`pins: ${padEl.size} pads, ${viaEl.size} pin barrels  (${el()})`);

// ---- windows ------------------------------------------------------------------------
const winOf = (g, margin = 6) => {
  const xs = quads[g].cells.map((c) => coilF[c][0]), ys = quads[g].cells.map((c) => coilF[c][1]);
  return winRect(Math.min(...xs) - pitch / 2 - margin, Math.min(...ys) - 4.9 - margin, Math.max(...xs) + pitch / 2 + margin, Math.max(...ys) + 4.9 + margin);
};
function winRect(x1, y1, x2, y2) {
  const I0 = gI(Math.max(x1, minX - 0.6)), I1 = gI(Math.min(x2, maxX + 0.6));
  const J0 = gJ(Math.max(y1, minY - 0.6)), J1 = gJ(Math.min(y2, maxY + 0.6));
  return { I0, J0, nx: I1 - I0 + 1, ny: J1 - J0 + 1 };
}
// every static thing in the window: bare board + (optionally) laid copper
const buildWindow = (W, withPlaced, halo = null) => {
  const R = new GridRouter({ x0: gX(W.I0), y0: gY(W.J0), nx: W.nx, ny: W.ny, hx, hy, wrap: false, layers: LAYERS });
  R.layerCost = LAYERS.map((l) => (l === 'B.Cu' || l === 'In12.Cu' ? 1 : 1.25));
  const x1 = R.x0 - 1, y1 = R.y0 - 1, x2 = R.x0 + W.nx * hx + 1, y2 = R.y0 + W.ny * hy + 1;
  const inW = (x, y) => x >= x1 && x <= x2 && y >= y1 && y <= y2;
  const C = (name) => (name === null ? 255 : R.cls(name));
  for (const [a, b, c, d] of outline) {
    if (Math.max(a, c) < x1 || Math.min(a, c) > x2 || Math.max(b, d) < y1 || Math.min(b, d) > y2) continue;
    R.addStatic(-1, { t: 'seg', ax: a, ay: b, bx: c, by: d, r: 0 }, 255, { clr: RULE.edge });
  }
  for (const v of vias) if (inW(v.x, v.y)) {
    R.addStatic(-1, { t: 'disc', x: v.x, y: v.y, r: v.r }, C(viaClass(v)));
    if (viaClass(v)) R.viaCells.add(R.cell(R.ix(v.x), R.jy(v.y)));
  }
  for (const fp of fps) for (const p of fp.pads) if (inW(p.x, p.y)) {
    R.addStatic(0, { t: 'rect', x: p.x, y: p.y, w: p.w, h: p.h, deg: p.deg }, p.net ? C(padClass(p)) : 255);
  }
  for (let k = 0; k < wseg.length; k += 6) {
    if (!inW(wseg[k], wseg[k + 1]) && !inW(wseg[k + 2], wseg[k + 3])) continue;
    R.addStatic(wseg[k + 5], { t: 'seg', ax: wseg[k], ay: wseg[k + 1], bx: wseg[k + 2], by: wseg[k + 3], r: wseg[k + 4] }, 255);
  }
  for (let k = 0; k < warc.length; k += 8) {
    if (!inW(warc[k + 2], warc[k + 3])) continue;
    const pts = arcPts(warc[k], warc[k + 1], warc[k + 2], warc[k + 3], warc[k + 4], warc[k + 5]);
    for (let q = 0; q + 1 < pts.length; q++) R.addStatic(warc[k + 7], { t: 'seg', ax: pts[q][0], ay: pts[q][1], bx: pts[q + 1][0], by: pts[q + 1][1], r: warc[k + 6] }, 255);
  }
  // halo: lands that still have nothing attached keep a one-track moat, so a
  // long net laid now cannot wall in a pin somebody has yet to reach
  if (halo) for (const p of halo) if (inW(p.x, p.y)) R.addStatic(0, { t: 'rect', x: p.x, y: p.y, w: p.w, h: p.h, deg: p.deg }, C(padClass(p)), { clr: RULE.clr + 0.30 });
  if (withPlaced) {
    const [wi0, wj0, wi1, wj1] = [W.I0 - 40, W.J0 - 40, W.I0 + W.nx + 40, W.J0 + W.ny + 40];
    for (const e of elements) {
      if (e.dead || (e.kind !== 'path' && e.kind !== 'lane')) continue;
      if (e.bbox[2] < wi0 || e.bbox[0] > wi1 || e.bbox[3] < wj0 || e.bbox[1] > wj1) continue;
      const cls = C(e.cls);
      if (e.kind === 'lane') {
        for (let q = 0; q + 1 < e.pts.length; q++) R.addStatic(1, { t: 'seg', ax: e.pts[q][0], ay: e.pts[q][1], bx: e.pts[q + 1][0], by: e.pts[q + 1][1], r: RULE.track / 2 }, cls, { track: true });
        continue;
      }
      const n = e.nodes;
      for (let q = 3; q < n.length; q += 3) {
        if (e.via[q / 3]) { R.addStatic(-1, { t: 'disc', x: gX(n[q + 1]), y: gY(n[q + 2]), r: RULE.viaDia / 2 }, cls); continue; }
        R.addStatic(n[q], { t: 'seg', ax: gX(n[q - 2]), ay: gY(n[q - 1]), bx: gX(n[q + 1]), by: gY(n[q + 2]), r: RULE.track / 2 }, cls, { track: true });
      }
    }
  }
  return R;
};

const hdrFp = fps.find((f) => f.ref === 'JSPINE');
const hdrBand = hdrFp ? (() => { let best = 0, bd = 1e9; coilF.forEach(([x, y], c) => { const d = Math.hypot(x - hdrFp.x, y - hdrFp.y); if (d < bd) { bd = d; best = c; } }); return quads[quadOfCell.get(best).g].band; })() : null;
const perBand = quads.filter((q) => q.band === 0).length, nBands = 1 + Math.max(...quads.map((q) => q.band));
const inBoard = (x, y) => { let odd = false; for (const [x0, y0, x1, y1] of outline) if ((y0 > y) !== (y1 > y) && x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) odd = !odd; return odd; };
const edgeClear = (x, y, d) => {
  if (!inBoard(x, y)) return false;
  for (const [x0, y0, x1, y1] of outline) {
    const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy, tt = L > 1e-12 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L)) : 0;
    if (Math.hypot(x - x0 - tt * dx, y - y0 - tt * dy) < d) return false;
  }
  return true;
};

// ---- phase 1: pattern -----------------------------------------------------------------
const mapStampNet = (name, g) => {
  const q = quads[g];
  let m;
  if ((m = /^coil_(\d+)_([AB])$/.exec(name))) { const c = q.cells[Qc.cells.indexOf(+m[1])]; return `coil${m[2]}_${c}`; }
  if ((m = /^PWM([AB])_(\d+)$/.exec(name))) return `PWM${m[1]}_${q.cells[Qc.cells.indexOf(+m[2])]}`;
  if (name === 'DATA_W') return `DATA_${g}`;
  if (name === 'DATA_E') return `DATA_${g + 1}`;
  return name.replace(/_C$/, '');
};
const rowOf = (g, y) => (Math.abs(y - coilF[quads[g].cells[0]][1]) < 3.6 ? 'S' : 'N');
let cand = [];                                     // legal candidates, before anchoring
const stats = quads.map(() => ({ paths: 0, legal: 0, kept: 0, lanes: 0, lanesKept: 0 }));
const patternOnly = process.env.PATTERN ? new Set(process.env.PATTERN.split(',').map(Number)) : null;   // feasibility probes
for (const [g, q] of quads.entries()) {
  if (patternOnly && !patternOnly.has(g)) continue;
  const W = winOf(g), R = buildWindow(W, false);
  const [di, dj] = quadShift(g), { nxy } = R;
  const legalNode = (cls, l, I, J) => {
    const iu = I - W.I0, ju = J - W.J0;
    if (iu < 0 || ju < 0 || iu >= W.nx || ju >= W.ny) return false;
    const s = R.stat[l * nxy + ju * W.nx + iu];
    return s === 0 || s === cls;
  };
  // lanes: one piece per ladder-to-ladder span, kept only if both ladders exist
  for (const ln of stamp.lanes) {
    if (ln.reserve) {
      // A reserved through-lane becomes copper only where the board has a long
      // east-west net to carry: lane 1 of the gap north of band b takes the
      // chain's return into band b+1; lane 2 of band 0's gap takes DATA_0 from
      // the header to the first register. Everywhere else the line stays empty.
      // the header sits in band hb: the gap south of it carries DATA_0 to the first
      // register, the gap north of it brings the chain's far end (DATA_M) back
      const net = ln.net === 'RET1' ? `DATA_${perBand * (q.band + 1)}`
        : ln.net === 'RET2' && hdrBand !== null && q.band === hdrBand - 1 ? 'DATA_0'
          : ln.net === 'RET2' && hdrBand !== null && q.band === hdrBand ? `DATA_${quads.length}` : null;
      if (!net || !netNum.has(net) || (ln.net === 'RET1' && q.band >= nBands - 1)) continue;
      const y = ln.pts[0][1] + dj * hy, xa = ln.pts[0][0] + di * hx, xb = ln.pts[1][0] + di * hx, NP = 8;
      for (let k = 0; k < NP; k++) {
        const ax = xa + ((xb - xa) * k) / NP, bx = xa + ((xb - xa) * (k + 1)) / NP;
        stats[g].lanes++;
        let ok = true;
        for (let s = 0; s <= 8 && ok; s++) ok = edgeClear(ax + ((bx - ax) * s) / 8, y, RULE.edge + ln.width / 2 + 0.01);
        for (const v of vias) { if (!ok) break; if (Math.abs(v.y - y) < v.r + RULE.clr + ln.width / 2 - 1e-6 && v.x > ax - 0.4 && v.x < bx + 0.4) ok = false; }
        if (!ok) continue;
        const nodes = [], rr = 0.6 * Math.max(hx, hy);
        for (let J = gJ(y - rr); J <= gJ(y + rr); J++) { if (Math.abs(gY(J) - y) > rr) continue; for (let I = gI(ax); I <= gI(bx); I++) nodes.push(1, I, J); }
        stats[g].lanesKept++;
        addElement({ cls: net, kind: 'lane', nodes, pts: [[ax, y], [bx, y]], width: ln.width, tag: { g, row: 'R' } });
      }
      continue;
    }
    const net = ln.net, cls = R.cls(net);
    const pts = ln.pts.map(([x, y]) => [x + di * hx, y + dj * hy]);
    const onLadder = pts.map(([x, y]) => boardVia(net, x, y));
    // split where the run passes a ladder barrel in mid-span
    const cuts = [0];
    for (let k = 1; k + 1 < pts.length; k++) if (onLadder[k]) cuts.push(k);
    const mids = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      for (const v of vias) {
        if (v.net !== net) continue;
        const [ax, ay] = pts[k], [bx, by] = pts[k + 1], L = Math.hypot(bx - ax, by - ay);
        const t = ((v.x - ax) * (bx - ax) + (v.y - ay) * (by - ay)) / (L * L);
        if (t > 0.02 && t < 0.98 && Math.hypot(ax + t * (bx - ax) - v.x, ay + t * (by - ay) - v.y) < 0.03) mids.push({ k, t, v });
      }
    }
    // rebuild as pieces between consecutive barrels
    const chain = [];
    for (let k = 0; k < pts.length; k++) {
      chain.push({ p: pts[k], v: onLadder[k] || null });
      for (const mdl of mids.filter((q2) => q2.k === k).sort((a, b) => a.t - b.t)) chain.push({ p: [mdl.v.x, mdl.v.y], v: mdl.v });
    }
    let start = 0;
    for (let k = 1; k < chain.length; k++) {
      if (!chain[k].v && k < chain.length - 1) continue;
      const piece = chain.slice(start, k + 1); start = k;
      stats[g].lanes++;
      if (!piece[0].v || !piece[piece.length - 1].v) continue;
      const nodes = [];
      let ok = true;
      for (let s = 0; s + 1 < piece.length && ok; s++) {
        const [ax, ay] = piece[s].p, [bx, by] = piece[s + 1].p;
        // every node within 0.6 h of the centreline -- the same set stamp2
        // offered the router as "on this lane", so paths that start on it share a node
        const rr = 0.6 * Math.max(hx, hy), L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        for (let J = gJ(Math.min(ay, by) - rr); J <= gJ(Math.max(ay, by) + rr) && ok; J++) for (let I = gI(Math.min(ax, bx) - rr); I <= gI(Math.max(ax, bx) + rr); I++) {
          const px = gX(I), py = gY(J);
          const t = L2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2)) : 0;
          if (Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)) > rr) continue;
          nodes.push(1, I, J);
        }
        // A lane is exact copper, laid to zero-margin tolerances by design
        // (0.39 mm from the bay ring, centre to centre): judge it on its true
        // centreline, not on grid nodes up to 0.6 h off it.
        const dSeg = (x, y) => { const tt = L2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)) : 0; return Math.hypot(x - ax - tt * (bx - ax), y - ay - tt * (by - ay)); };
        for (const v of vias) {
          if (v.net === net || Math.abs(v.x - (ax + bx) / 2) > Math.abs(bx - ax) / 2 + 1 || Math.abs(v.y - (ay + by) / 2) > Math.abs(by - ay) / 2 + 1) continue;
          if (dSeg(v.x, v.y) < v.r + RULE.clr + ln.width / 2 - 1e-6) { ok = false; break; }
        }
        for (const [ox, oy, px2, py2] of outline) {
          if (!ok) break;
          for (const [qx, qy] of [[ox, oy], [px2, py2]]) if (dSeg(qx, qy) < RULE.edge + ln.width / 2) { ok = false; break; }
        }
      }
      if (!ok) continue;
      // the run ends ON its ladder barrels: share their centre nodes, whichever
      // grid row the run's own centreline rounds to
      for (const c of [piece[0], piece[piece.length - 1]]) nodes.push(1, gI(c.v.x), gJ(c.v.y));
      stats[g].lanesKept++;
      addElement({ cls: net, kind: 'lane', nodes, pts: piece.map((c) => c.p), width: ln.width, tag: { g, row: rowOf(g, piece[0].p[1]) } });
    }
  }
  for (const p of stamp.paths) {
    stats[g].paths++;
    const clsName = mapStampNet(p.net, g);
    if (!netNum.has(classNet(clsName))) continue;
    const cls = R.cls(clsName), nodes = [];
    let ok = true;
    for (let k = 0; k < p.nodes.length && ok; k++) {
      const l = LI.get(p.nodes[k][0]), I = p.nodes[k][1] + di, J = p.nodes[k][2] + dj;
      if (!legalNode(cls, l, I, J)) { ok = false; break; }
      if (p.via[k]) {
        const c = (J - W.J0) * W.nx + (I - W.I0);
        if (R.viaStat[c] || (R.viaOwn[c] && R.viaOwn[c] !== cls)) { ok = false; break; }
      }
      nodes.push(l, I, J);
    }
    if (!ok) continue;
    stats[g].legal++;
    cand.push({ cls: clsName, kind: 'path', nodes, via: Uint8Array.from(p.via), tag: { g, to: p.to, link: p.link, stamp: true } });
  }
  if (g % 6 === 5) console.log(`  pattern: band ${q.band} tested  (${el()})`);
}
// anchoring: both ends of a path must sit on same-class copper that stays
{
  const count = new Map();                         // cls -> Map key -> # elements holding the node
  const bump = (cls, n, d) => {
    if (!count.has(cls)) count.set(cls, new Map());
    const M = count.get(cls);
    const seen = new Set();
    for (let k = 0; k < n.length; k += 3) {
      const key = gkey(n[k], n[k + 1], n[k + 2]);
      if (seen.has(key)) continue;
      seen.add(key); M.set(key, (M.get(key) || 0) + d);
    }
  };
  for (const e of elements) bump(e.cls, e.nodes, 1);
  for (const c of cand) bump(c.cls, c.nodes, 1);
  let dropped = 0;
  for (;;) {
    const keep = [];
    let changed = false;
    for (const c of cand) {
      const M = count.get(c.cls), n = c.nodes, L = n.length;
      const a = M.get(gkey(n[0], n[1], n[2])), b = M.get(gkey(n[L - 3], n[L - 2], n[L - 1]));
      if (a >= 2 && b >= 2) { keep.push(c); continue; }
      bump(c.cls, n, -1); changed = true; dropped++;
    }
    cand = keep;
    if (!changed) break;
  }
  for (const c of cand) { addElement(c); stats[c.tag.g].kept++; }
  console.log(`pattern: ${cand.length} stamp paths laid, ${dropped} legal-but-unanchored dropped  (${el()})`);
}
console.log('paths kept per quad (rows = band 6..0, cols = pos 0..5), of ' + stamp.paths.length + ':');
for (let band = 6; band >= 0; band--) {
  console.log('  ' + [0, 1, 2, 3, 4, 5].map((pos) => { const g = quads.findIndex((q) => q.band === band && q.pos === pos); return String(stats[g].kept).padStart(3) + `/${String(stats[g].lanesKept).padStart(2)}L`; }).join('  '));
}

// ---- what does each quad still need? ------------------------------------------------------
const comp = (id) => find(id);
const busMain = new Map();                         // bus net -> Set of component roots holding a lane
const refreshMain = () => {
  busMain.clear();
  for (const e of elements) if (e.kind === 'lane' && !e.dead) {
    if (!busMain.has(e.cls)) busMain.set(e.cls, new Set());
    busMain.get(e.cls).add(find(e.id));
  }
};
// service parts (header, dead-man) belong to the quad they sit in: their bus
// pins and their own little nets are negotiated with that quad's patch
const extraOf = quads.map(() => []);
for (const fp of fps) {
  if (/^(SR|U|C)\d+$/.test(fp.ref)) continue;
  let best = 0, bd = 1e9;
  coilF.forEach(([x, y], c) => { const d = Math.hypot(x - fp.x, y - fp.y); if (d < bd) { bd = d; best = c; } });
  extraOf[quadOfCell.get(best).g].push(fp);
}
const hasPinVia = new Set([...viaEl.keys()].map((v) => v.net));
// a chain net with neither a seam barrel nor a reserved lane has to be routed whole
const isLongNet = (cls) => /^DATA_\d+$/.test(cls) && !hasPinVia.has(cls) && !elements.some((e) => e.kind === 'lane' && !e.dead && e.cls === cls);
const quadJobs = (g) => {
  const q = quads[g], jobs = [];
  const SR = fpByRef.get(`SR${g}`);
  const pin = (ref, name) => padEl.get(`${ref}.${name}`);
  const two = (cls, a, b, what) => { if (a === undefined || b === undefined) return; if (comp(a) !== comp(b)) jobs.push({ cls, from: [comp(a)], to: comp(b), what }); };
  q.cells.forEach((c) => {
    const U = fpByRef.get(`U${c}`);
    for (const ab of ['A', 'B']) {
      const nm = `PWM${ab}_${c}`;
      two(nm, pin(SR.ref, SR.pads.find((p) => p.net === nm).name), pin(U.ref, U.pads.find((p) => p.net === nm).name), nm);
      const t = ab === 'A' ? 0 : 1;
      const v = vias.find((w) => w.net === `coil_${c}` && Math.hypot(w.x - coilF[c][0] - termOff[t][0], w.y - coilF[c][1] - termOff[t][1]) < 0.05);
      two(`coil${ab}_${c}`, viaEl.get(v), pin(U.ref, ab === 'A' ? '2' : '6'), `coil_${c}_${ab}`);
    }
  });
  const dv = (cell, dxp, net) => { const v = boardVia(net, coilF[cell][0] + 3.83 + dxp * pitch, coilF[cell][1] + 2.10, 0.03); return v ? viaEl.get(v) : undefined; };
  two(`DATA_${g + 1}`, pin(SR.ref, '2'), dv(q.cells[1], 0, `DATA_${g + 1}`), 'DATA_E');
  two(`DATA_${g}`, dv(q.cells[0], -1, `DATA_${g}`), pin(SR.ref, '12'), 'DATA_W');
  // chain ends at the board edge (and the header's DATA pins): onto the reserved lane
  const W0 = winOf(g);
  const laneNear = (net) => elements.some((e) => e.kind === 'lane' && !e.dead && e.cls === net && e.bbox[2] >= W0.I0 && e.bbox[0] < W0.I0 + W0.nx && e.bbox[3] >= W0.J0 && e.bbox[1] < W0.J0 + W0.ny);
  const toLane = (p) => {
    const main = busMain.get(p.net), id = pin(p.ref, p.name);
    if (main && main.size && hasPinVia.has(p.net) === false && laneNear(p.net) && !main.has(comp(id))) jobs.push({ cls: p.net, from: 'main', to: comp(id), what: `${p.net}>${p.ref}.${p.name}` });
  };
  for (const name of ['2', '12']) toLane(SR.pads.find((p) => p.name === name));
  for (const fp of extraOf[g]) for (const p of fp.pads) if (/^DATA_\d+$/.test(p.net)) toLane(p);
  // the service parts' own nets (SYNC, DEADMAN_G): every pad of the net in one piece
  const local = new Map();
  for (const fp of extraOf[g]) for (const p of fp.pads) if (p.net && !BUS.includes(p.net) && !/^DATA_\d+$/.test(p.net)) {
    if (!local.has(p.net)) local.set(p.net, fps.flatMap((f2) => f2.pads.filter((p2) => p2.net === p.net)));
  }
  for (const [net, pads] of local) for (let k = 1; k < pads.length; k++) two(net, pin(pads[k - 1].ref, pads[k - 1].name), pin(pads[k].ref, pads[k].name), `${net}:${pads[k].ref}.${pads[k].name}`);
  for (const net of BUS) {
    const main = busMain.get(net) || new Set();
    for (const ref of [SR.ref, ...q.cells.flatMap((c) => [`U${c}`, `C${c}`]), ...extraOf[g].map((f2) => f2.ref)]) for (const p of fpByRef.get(ref).pads) {
      if (p.net !== net) continue;
      const id = pin(ref, p.name);
      if (!main.has(comp(id))) jobs.push({ cls: net, from: 'main', to: comp(id), what: `${net}>${ref}.${p.name}` });
    }
    // the quad's own two lane rows must be one piece (the in-stamp link, or a patch)
    const rows = { S: new Set(), N: new Set() };
    for (const e of elements) if (e.kind === 'lane' && !e.dead && e.cls === net && e.tag.g === g) rows[e.tag.row].add(comp(e.id));
    if (rows.S.size && rows.N.size && ![...rows.S].some((c) => rows.N.has(c))) {
      jobs.push({ cls: net, from: [...rows.S], to: [...rows.N][0], what: `${net} rows`, link: true });
    }
  }
  return jobs;
};
refreshMain();
if (process.env.DBG_ROWS) {
  const g = +process.env.DBG_ROWS, net = 'GND';
  for (const e of elements) {
    if (e.cls !== net) continue;
    if (e.kind === 'lane' && e.tag.g === g) console.log('lane', e.tag.row, 'comp', find(e.id), e.pts[0], e.pts[e.pts.length - 1], 'nodes', e.nodes.length / 3);
    if (e.kind === 'path' && e.tag.g === g) console.log('path', e.tag.to, e.tag.link ? 'link' : '', 'comp', find(e.id), [LAYERS[e.nodes[0]], gX(e.nodes[1]).toFixed(3), gY(e.nodes[2]).toFixed(3)], '->', [gX(e.nodes[e.nodes.length - 2]).toFixed(3), gY(e.nodes[e.nodes.length - 1]).toFixed(3)]);
  }
}
const need = quads.map((_, g) => quadJobs(g));
console.log('open connections per quad after patterning:');
for (let band = 6; band >= 0; band--) console.log('  ' + [0, 1, 2, 3, 4, 5].map((pos) => String(need[quads.findIndex((q) => q.band === band && q.pos === pos)].length).padStart(3)).join(' '));

// ---- phase 2: patch ------------------------------------------------------------------------
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;
const report = [];
const patch = (label, W, jobsOf, { seed = 1, iters = +(process.env.ITERS || 120), force = true, halo = null } = {}) => {
  refreshMain();
  const jobs = jobsOf();
  if (!jobs.length) return { ok: true, jobs: 0 };
  const R = buildWindow(W, true, halo), { nxy } = R;
  // local node lists of a component (all its elements inside the window)
  const byComp = new Map();
  const nodesOf = (roots, cls) => {
    const out = [];
    for (const e of elements) {
      if (e.dead || e.cls !== cls || !roots.has(find(e.id))) continue;
      if (e.bbox[2] < W.I0 || e.bbox[0] >= W.I0 + W.nx || e.bbox[3] < W.J0 || e.bbox[1] >= W.J0 + W.ny) continue;
      const n = e.nodes;
      for (let k = 0; k < n.length; k += 3) {
        const iu = n[k + 1] - W.I0, ju = n[k + 2] - W.J0;
        if (iu >= 0 && ju >= 0 && iu < W.nx && ju < W.ny) out.push([n[k], iu, ju]);
      }
    }
    return out;
  };
  const nets = new Map();
  for (const j of jobs) {
    if (!nets.has(j.cls)) nets.set(j.cls, { name: j.cls, cls: R.cls(j.cls), groups: [], jobs: [], tree: [], gi: new Map() });
    const N = nets.get(j.cls);
    const grp = (key, roots) => {
      if (!N.gi.has(key)) { N.gi.set(key, N.groups.length); N.groups.push({ name: key, nodes: nodesOf(roots, j.cls) }); }
      return N.gi.get(key);
    };
    const to = grp(`c${j.to}`, new Set([j.to]));
    if (j.from === 'main') {
      const m = grp('main', j.mainRoots || busMain.get(j.cls) || new Set());
      if (!N.tree.includes(m)) N.tree.push(m);
      N.jobs.push({ from: 'tree', to, what: j.what });
    } else {
      N.jobs.push({ from: [grp(`f${j.from.join('+')}`, new Set(j.from))], to, what: j.what, join: false });
    }
  }
  for (const N of nets.values()) R.addNet(N);
  const empty = R.nets.flatMap((n) => n.jobs.filter((j) => !n.groups[j.to].nodes.length || (j.from === 'tree' ? !n.tree.some((gi) => n.groups[gi].nodes.length) : !j.from.some((gi) => n.groups[gi].nodes.length))).map((j) => j.what));
  if (empty.length) console.log(`    ${label}: window holds no copper for one end of [${empty.join(' ')}]`);
  const res = R.negotiate({ maxIter: iters, seed, log: () => {} });
  if (res.ok) { R.polish(2, () => {}); for (let r = 0; r < 2; r++) for (const net of R.nets) R.smooth(net); }
  const bad = R.nets.filter((n) => R.conflicts(n).length).map((n) => n.name);
  const failed = R.nets.flatMap((n) => n.failed.map((j) => {
    // why: is one end walled in by static copper?
    const nd = (gi) => n.groups[gi].nodes.map(([l, iu, ju]) => l * nxy + ju * W.nx + iu);
    const pt = R.pocket(n, nd(j.to)), ps = j.from === 'tree' ? -1 : R.pocket(n, j.from.flatMap(nd));
    return j.what + (pt >= 0 ? ` (target walled in: ${pt} nodes)` : ps >= 0 ? ` (source walled in: ${ps} nodes)` : ' (no path)');
  }));
  let laid = 0;
  const allOk = res.ok && !bad.length && !failed.length;
  if (!allOk && !force) return { ok: false, jobs: jobs.length, laid: 0, bad, failed };
  for (const net of R.nets) {
    if (bad.includes(net.name)) continue;          // never lay copper that still collides
    for (const p of net.paths) {
      const nodes = [];
      for (let k = 0; k < p.nodes.length; k++) nodes.push((p.nodes[k] / nxy) | 0, p.unw[2 * k] + W.I0, p.unw[2 * k + 1] + W.J0);
      addElement({ cls: net.name, kind: 'path', nodes, via: p.via, tag: { patch: label, what: p.job.what } });
      laid++;
    }
  }
  return { ok: res.ok && !bad.length && !failed.length, jobs: jobs.length, laid, bad, failed, iters: res.iters };
};
// ---- board-level nets --------------------------------------------------------------------------
// Whatever is in more than one piece and is not a quad's own business: the DATA
// chain's band-to-band returns and header ends, stray ladder barrels, anything a
// quad patch left behind. One net at a time, in a window around its loose end.
const boardNets = (title, want, { halo = false, skipService = false } = {}) => {
  const tasksNow = () => {
    refreshMain();
    const byCls = new Map();
    for (const e of elements) {
      if (e.dead || e.kind === 'path' || /^coil/.test(e.cls)) continue;
      if (!byCls.has(e.cls)) byCls.set(e.cls, []);
      byCls.get(e.cls).push(e);
    }
    const tasks = [];
    for (const [cls, els] of byCls) {
      if (!want(cls)) continue;
      const roots = new Map();
      for (const e of els) { const r = find(e.id); if (!roots.has(r)) roots.set(r, []); roots.get(r).push(e); }
      if (roots.size < 2) continue;
      let main = null, best = -1;
      for (const [r, list] of roots) { const sc = list.filter((e) => e.kind === 'lane').length * 1000 + list.length; if (sc > best) { best = sc; main = r; } }
      for (const [r, list] of roots) {
        if (r === main) continue;
        // a service part's pin is its quad's business (negotiated with that quad)
        if (skipService && list.some((e) => e.kind === 'pad' && !/^(SR|U|C)\d+$/.test(e.pad.ref))) continue;
        tasks.push({ cls, main, root: r, els: list, mainEls: roots.get(main), bus: BUS.includes(cls) });
      }
    }
    return tasks;
  };
  const describe = (t) => t.els.map((e) => (e.kind === 'pad' ? `${e.pad.ref}.${e.pad.name}` : e.kind)).slice(0, 3).join('+');
  const tried = new Set();
  for (;;) {
    const t = tasksNow().find((q) => !tried.has(`${q.cls}|${describe(q)}`));
    if (!t) break;
    tried.add(`${t.cls}|${describe(t)}`);
    let i0 = 1e9, j0 = 1e9, i1 = -1e9, j1 = -1e9;
    const grow = (e) => { i0 = Math.min(i0, e.bbox[0]); j0 = Math.min(j0, e.bbox[1]); i1 = Math.max(i1, e.bbox[2]); j1 = Math.max(j1, e.bbox[3]); };
    t.els.forEach(grow);
    const mainLanes = t.mainEls.filter((e) => e.kind === 'lane');
    if (mainLanes.length && !t.bus) {
      // a chain net on its reserved lane: aim for the lane piece nearest the loose end
      const cx = (i0 + i1) / 2, cy = (j0 + j1) / 2;
      const d = (e) => Math.hypot(Math.max(e.bbox[0] - cx, cx - e.bbox[2], 0) * hx, Math.max(e.bbox[1] - cy, cy - e.bbox[3], 0) * hy);
      grow(mainLanes.reduce((a, b) => (d(b) < d(a) ? b : a)));
    } else if (!t.bus) t.mainEls.forEach(grow);     // a small net: both ends must be in view
    // a trunk heading for a lane needs room to swing round the rim cells
    let m = t.bus ? 8 : mainLanes.length ? 11 : 5, W;
    for (;;) { W = winRect(gX(i0) - m, gY(j0) - m, gX(i1) + m, gY(j1) + m); if (W.nx * W.ny * LAYERS.length < 80e6 || m <= 1.5) break; m -= 0.5; }
    const what = `${t.cls}>${describe(t)}`;
    // lands with nothing on them yet (and not this net's own) get the moat
    let moat = null;
    if (halo) {
      const size = new Map();
      for (const e of elements) if (!e.dead) size.set(find(e.id), (size.get(find(e.id)) || 0) + 1);
      // ...but not the neighbours of this net's own pins: at 0.5 mm pitch their
      // moats would wall the pin in (measured: SR.12, "target walled in: 284 nodes")
      const own = new Set([...t.els, ...t.mainEls].filter((e) => e.kind === 'pad').map((e) => e.pad.ref));
      moat = elements.filter((e) => e.kind === 'pad' && e.cls !== t.cls && !own.has(e.pad.ref) && size.get(find(e.id)) === 1).map((e) => e.pad);
    }
    const r = patch(what, W, () => [{ cls: t.cls, from: 'main', mainRoots: new Set([t.main]), to: t.root, what }], { halo: moat });
    report.push({ net: what, ...r });
    console.log(`  net ${what} (${(W.nx * hx).toFixed(0)} x ${(W.ny * hy).toFixed(0)} mm window): ${r.ok ? `ok, ${r.iters} iters` : `FAILED  conflicts [${(r.bad || []).join(' ')}]  unroutable [${(r.failed || []).join(' ')}]`}  (${el()})`);
  }
  const leftT = tasksNow();
  console.log(leftT.length ? `${title}: STILL OPEN (${leftT.length}): ${leftT.map((t) => `${t.cls}>${describe(t)}`).join('  ')}` : `${title}: all joined`);
};
// Long nets FIRST, while every loose pin still has the corridor the stamp left
// for it: a rim patch laid before them walled SR.12 in on the west edge.
if (!process.env.SKIP_PATCH && !only) boardNets('chain returns', (cls) => isLongNet(cls) || cls === `DATA_${quads.length}`, { halo: true, skipService: true });
if (!process.env.SKIP_PATCH) {
  // rim quads last-to-first by how much they need, so easy ones settle before the corners
  const order = quads.map((_, g) => g).filter((g) => need[g].length && (!only || only.has(g))).sort((a, b) => need[a].length - need[b].length);
  for (const g of order) {
    // Nothing is laid until the whole quad settles: copper from a negotiation
    // that did not converge is exactly what the leftovers cannot get past.
    // Escalation: another order; then give the quad's own patterned stamp
    // paths back to the router (rip them up, route the quad from scratch);
    // only at the very end lay whatever did settle.
    let r = patch(`q${g}`, winOf(g), () => quadJobs(g), { force: false });
    // neighbours that were whole before a rip-up: a stamp path of THIS quad may
    // be what feeds one of THEIR pads (the periodic solution serves a pad from
    // whichever image is nearest), so what the rip-up opens there is part of
    // this negotiation -- left for later it was found walled in.
    let dependants = [];
    const jobsWith = () => [...quadJobs(g), ...dependants.flatMap((h) => quadJobs(h))];
    for (let a = 2; a <= 5 && !r.ok; a++) {
      console.log(`    quad ${g}: attempt ${a - 1} left [${[...(r.bad || []), ...(r.failed || [])].join(' ')}]`);
      // a pin walled in by STATIC copper will not be freed by another order:
      // go straight to the rip-up
      if (a === 2 && (r.failed || []).length) a = 3;
      if (a === 3) {
        refreshMain();
        dependants = quads.map((_, h) => h).filter((h) => h !== g && Math.abs(quads[h].band - quads[g].band) <= 1 && Math.abs(quads[h].pos - quads[g].pos) <= 1 && quadJobs(h).length === 0);
        let n = 0;
        for (const e of elements) if (e.kind === 'path' && !e.dead && e.tag.stamp && e.tag.g === g && !e.tag.link) { e.dead = true; n++; }
        rebuild();
        refreshMain();
        console.log(`    quad ${g}: ripped up its ${n} patterned stamp paths (opening ${dependants.reduce((s, h) => s + quadJobs(h).length, 0)} connections in finished neighbours); routing from scratch`);
      }
      r = patch(`q${g}`, winOf(g, a >= 3 ? 9 : 6), jobsWith, { seed: a, iters: a >= 3 ? 300 : 200, force: a === 5 });
    }
    report.push({ g, ...r });
    console.log(`  patch quad ${String(g).padStart(2)} (band ${quads[g].band} pos ${quads[g].pos}): ${r.jobs} jobs -> ${r.ok ? `ok, ${r.laid} paths, ${r.iters} iters` : `INCOMPLETE  conflicts [${(r.bad || []).join(' ')}]  unroutable [${(r.failed || []).join(' ')}]`}  (${el()})`);
  }
  refreshMain();
  const left = quads.map((_, g) => quadJobs(g));
  console.log('open connections per quad after patching:');
  for (let band = 6; band >= 0; band--) console.log('  ' + [0, 1, 2, 3, 4, 5].map((pos) => String(left[quads.findIndex((q) => q.band === band && q.pos === pos)].length).padStart(3)).join(' '));
  const all = left.flatMap((j, g) => j.map((x) => `q${g}:${x.what}`));
  if (all.length) console.log(`STILL OPEN (${all.length}): ${all.join('  ')}`);
}

if (!process.env.SKIP_PATCH && !only) boardNets('board-level nets', () => true);

// Reserved lanes are laid whole; cut each chain back to its outermost tap so no
// stub hangs past the junction (an antenna, and a track_dangling warning).
{
  const R = elements.filter((e) => e.kind === 'lane' && !e.dead && e.tag.row === 'R');
  const byCls = new Map();
  for (const e of R) { if (!byCls.has(e.cls)) byCls.set(e.cls, []); byCls.get(e.cls).push(e); }
  let cutN = 0;
  for (const [cls, list] of byCls) {
    // x of every routed path node of this net that lies on the lane line
    const taps = [];
    for (const e of elements) if (e.kind === 'path' && !e.dead && e.cls === cls) {
      const n = e.nodes;
      for (let k = 0; k < n.length; k += 3) if (n[k] === 1 && Math.abs(gY(n[k + 2]) - list[0].pts[0][1]) < 0.02) taps.push(gX(n[k + 1]));
    }
    if (taps.length < 2) { for (const e of list) e.dead = true; cutN += list.length; continue; }
    const lo = Math.min(...taps), hi = Math.max(...taps);
    for (const e of list) {
      const [a, b] = [e.pts[0][0], e.pts[1][0]];
      if (b <= lo || a >= hi) { e.dead = true; cutN++; continue; }
      e.pts = [[Math.max(a, lo), e.pts[0][1]], [Math.min(b, hi), e.pts[1][1]]];
    }
  }
  if (cutN) console.log(`reserved lanes: ${cutN} unused pieces removed, ends trimmed to their taps`);
}

// ---- write the board -------------------------------------------------------------------------
const f = (v) => +v.toFixed(6);
const outL = [];
const byNet = new Map();
for (const e of elements) {
  if (e.dead) continue;
  if (e.kind === 'lane') {
    const nn = netNum.get(e.cls);
    for (let q = 0; q + 1 < e.pts.length; q++) outL.push(`  (segment (start ${f(e.pts[q][0])} ${f(e.pts[q][1])}) (end ${f(e.pts[q + 1][0])} ${f(e.pts[q + 1][1])}) (width ${f(e.width)}) (layer "In12.Cu") (net ${nn}))`);
  } else if (e.kind === 'path') {
    const net = classNet(e.cls);
    if (!byNet.has(net)) byNet.set(net, []);
    byNet.get(net).push(e);
  }
}
let nSeg = outL.length, nVia = 0;
for (const [net, paths] of byNet) {
  const nn = netNum.get(net);
  const edges = new Map(), breaks = new Set(), viaSet = new Map(), tails = [];
  const K = (I, J) => (J + OFF) * GW + (I + OFF);
  for (const p of paths) {
    const n = p.nodes, L = n.length / 3;
    for (let k = 0; k < L; k++) {
      const l = n[3 * k], I = n[3 * k + 1], J = n[3 * k + 2];
      if (k === 0 || k === L - 1 || p.via[k] || (k + 1 < L && p.via[k + 1])) breaks.add(l * 1e12 + K(I, J));
      if (k === 0 || k === L - 1) {
        const v = viaAt.get(`${I},${J}`);
        if (v && v.net === net && Math.hypot(v.x - gX(I), v.y - gY(J)) > 1e-4) tails.push([l, gX(I), gY(J), v.x, v.y]);
      }
      if (k === 0) continue;
      if (p.via[k]) { viaSet.set(K(I, J), [gX(I), gY(J)]); continue; }
      if (!edges.has(l)) edges.set(l, new Map());
      const E = edges.get(l), a = K(n[3 * k - 2], n[3 * k - 1]), b = K(I, J);
      if (!E.has(a)) E.set(a, new Set()); if (!E.has(b)) E.set(b, new Set());
      E.get(a).add(b); E.get(b).add(a);
    }
  }
  const xyOf = (k) => [(k % GW) - OFF, Math.floor(k / GW) - OFF];
  const seg = (l, a, b) => { const [a0, a1] = xyOf(a), [b0, b1] = xyOf(b); outL.push(`  (segment (start ${f(gX(a0))} ${f(gY(a1))}) (end ${f(gX(b0))} ${f(gY(b1))}) (width ${RULE.track}) (layer "${LAYERS[l]}") (net ${nn}))`); nSeg++; };
  for (const [l, E] of edges) {
    const isBreak = (k) => {
      if (breaks.has(l * 1e12 + k)) return true;
      const nb = [...E.get(k)];
      if (nb.length !== 2) return true;
      const [a, b] = nb.map(xyOf), c = xyOf(k);
      return (a[0] - c[0]) !== (c[0] - b[0]) || (a[1] - c[1]) !== (c[1] - b[1]);
    };
    const used = new Set();
    const walk = (s, nb) => {
      let prev = s, cur = nb;
      used.add(`${prev}>${cur}`); used.add(`${cur}>${prev}`);
      while (!isBreak(cur)) {
        const nx2 = [...E.get(cur)].find((q) => q !== prev);
        prev = cur; cur = nx2;
        used.add(`${prev}>${cur}`); used.add(`${cur}>${prev}`);
        if (cur === s) break;
      }
      seg(l, s, cur);
    };
    for (const k of E.keys()) if (isBreak(k)) for (const nb of E.get(k)) if (!used.has(`${k}>${nb}`)) walk(k, nb);
    for (const k of E.keys()) for (const nb of E.get(k)) if (!used.has(`${k}>${nb}`)) walk(k, nb);
  }
  for (const [l, ax, ay, bx, by] of tails) { outL.push(`  (segment (start ${f(ax)} ${f(ay)}) (end ${f(bx)} ${f(by)}) (width ${RULE.track}) (layer "${LAYERS[l]}") (net ${nn}))`); nSeg++; }
  for (const [x, y] of viaSet.values()) { outL.push(`  (via (at ${f(x)} ${f(y)}) (size ${RULE.viaDia}) (drill ${RULE.viaDrill}) (layers "F.Cu" "B.Cu") (net ${nn}))`); nVia++; }
}
const cut = txt.lastIndexOf('\n)');
writeFileSync(`${OUT}.kicad_pcb`, txt.slice(0, cut) + '\n' + outL.join('\n') + txt.slice(cut));
console.log(`wrote ${OUT}.kicad_pcb: ${nSeg} segments, ${nVia} vias  (${el()})`);
writeFileSync(`${OUT}.assemble.json`, JSON.stringify({ stats, need: need.map((j) => j.map((x) => x.what)), report }, null, 1));
