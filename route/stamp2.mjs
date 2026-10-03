// The periodic quad stamp, routed as a TORUS by gridrouter.mjs.
//
//   node stamp2.mjs <boardKey> <out.ses> [lanes.ses]
//
// Reads the bare 12x14 board, takes ONE lattice period of its static copper
// around the centre quad (every interior quad is an exact translate -- that is
// verified by the audit, not assumed), wraps it onto the torus, and negotiates
// every net of the quad at once on all 14 copper layers. Straight In12 lane
// runs (and the power trunks) are taken as fixed copper from an existing
// session: they are ladder-to-ladder by construction and nothing to search.
//
// env: GRID (mm, default 0.025), LAYERS (routing layers, default all 14),
//      ITERS, MESH=1 (also link the lane rows north-south inside the stamp),
//      DUMP=<file.json> (geometry for render2.py)
import { readFileSync, writeFileSync } from 'fs';
import { GridRouter, netGeometry, RULE } from './gridrouter.mjs';
import { makeStator } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize } from '../src/kicad.js';

const B = process.argv[2] || 'fabtile2';
const OUT = process.argv[3] || `${B}.t2.ses`;
const LANES = process.argv[4] || `${B}.union.ses`;
const spec = JSON.parse(readFileSync(`${B}.quads.json`, 'utf8'));
const { quads, centreQuad } = spec;
const Q = quads[centreQuad];
const txt = readFileSync(`${B}.kicad_pcb`, 'utf8');

// ---- board -------------------------------------------------------------------
const netName = new Map();
for (const m of txt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netName.set(+m[1], m[2]);
const outline = [];
for (const m of txt.matchAll(/\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)/g)) outline.push([+m[1], +m[2], +m[3], +m[4]]);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [a, b, c, d] of outline) { minX = Math.min(minX, a, c); maxX = Math.max(maxX, a, c); minY = Math.min(minY, b, d); maxY = Math.max(maxY, b, d); }
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coilF = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);
const quadOfCell = new Map();
quads.forEach((q, g) => q.cells.forEach((c, k) => quadOfCell.set(c, { g, k })));

const org = (q) => coilF[q.cells[0]];
const east = quads.find((q) => q.band === Q.band && q.pos === Q.pos + 1);
const north = quads.find((q) => q.band === Q.band + 1 && q.pos === Q.pos);
const AX = org(east)[0] - org(Q)[0], BY = Math.abs(org(north)[1] - org(Q)[1]);
if (Math.abs(org(east)[1] - org(Q)[1]) > 1e-6 || Math.abs(org(north)[0] - org(Q)[0]) > 1e-6) throw new Error('lattice is not rectangular');

const pitch = cfg.stator.coilPitch * 1000;
const [c0x, c0y] = org(Q);
const GRID = +(process.env.GRID || 0.025);
const nx = Math.round(AX / GRID), ny = Math.round(BY / GRID);
const X0 = c0x - pitch / 2, Y0 = c0y - 11.0;
const ALL_CU = ['B.Cu', 'In12.Cu', 'In11.Cu', 'In10.Cu', 'In9.Cu', 'In8.Cu', 'In7.Cu', 'In6.Cu', 'In5.Cu', 'In4.Cu', 'In3.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu'];
const layers = (process.env.LAYERS || ALL_CU.join(',')).split(',');
const R = new GridRouter({ x0: X0, y0: Y0, nx, ny, hx: AX / nx, hy: BY / ny, wrap: true, layers });
R.layerCost = layers.map((l) => (l === 'B.Cu' || l === 'In12.Cu' ? 1 : 1.25));
const LI = new Map(layers.map((l, k) => [l, k]));
console.log(`torus ${AX.toFixed(4)} x ${BY.toFixed(4)} mm, grid ${nx} x ${ny} (${R.hx.toFixed(5)}, ${R.hy.toFixed(5)}), ${layers.length} layers, ${(R.N / 1e6).toFixed(1)}M nodes`);

// ---- classes --------------------------------------------------------------------
const GLOBALS = ['GND', 'VBUS', 'VLOGIC', 'SCLK', 'RCLK', 'OE_N', 'SDA', 'SCL'];
const gPlan = pcbCoilGeometry(cfg);
const planT = viaPlan(gPlan, gPlan.layers, pitch / 2, viaSize(gPlan, pitch / 2), spec.viaPlanOpts || {});
const termOff = planT.termVias.map((t) => t.p);            // [IN, OUT], file-frame cell offsets
const BLOCK = 255;
const classOfVia = (name, x, y) => {
  if (GLOBALS.includes(name)) return R.cls(name);
  if (/^DATA_\d+$/.test(name)) return R.cls('DATA_V');
  const m = /^coil_(\d+)$/.exec(name);
  if (m) {
    const [ccx, ccy] = coilF[+m[1]], k = quadOfCell.get(+m[1]).k;
    if (Math.hypot(x - ccx - termOff[0][0], y - ccy - termOff[0][1]) < 0.05) return R.cls(`coilA_k${k}`);
    if (Math.hypot(x - ccx - termOff[1][0], y - ccy - termOff[1][1]) < 0.05) return R.cls(`coilB_k${k}`);
  }
  return BLOCK;
};
const classOfPad = (name, pad) => {
  if (GLOBALS.includes(name)) return R.cls(name);
  if (/^DATA_\d+$/.test(name)) return R.cls(pad === '12' ? 'DATA_W' : 'DATA_E');
  let m = /^(PWM[AB])_(\d+)$/.exec(name);
  if (m) return R.cls(`${m[1]}_k${quadOfCell.get(+m[2]).k}`);
  m = /^coil_(\d+)$/.exec(name);
  if (m) return R.cls(`coil${pad === '2' ? 'A' : 'B'}_k${quadOfCell.get(+m[1]).k}`);
  return BLOCK;
};

// ---- one period of static copper -----------------------------------------------
const EPS = 1e-3;
const inPeriod = (x, y) => x >= X0 - EPS && x < X0 + AX + EPS && y >= Y0 - EPS && y < Y0 + BY + EPS;
let nStat = 0;
const t0 = Date.now();
const vias = [];
for (const m of txt.matchAll(/^  \(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill ([\d.]+)\) \(layers "[^"]+" "[^"]+"\) \(net (\d+)\)\)/gm)) {
  vias.push({ x: +m[1], y: +m[2], r: +m[3] / 2, net: netName.get(+m[5]) });
}
for (const v of vias) {
  if (!inPeriod(v.x, v.y)) continue;
  R.addStatic(-1, { t: 'disc', x: v.x, y: v.y, r: v.r }, classOfVia(v.net, v.x, v.y)); nStat++;
}
const fps = [];
for (const m of txt.matchAll(/  \(footprint "maglev:([^"]+)" \(layer "([^"]+)"\) \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)([\s\S]*?)\n  \)\n/g)) {
  if (m[5] && +m[5] !== 0) throw new Error('rotated footprint: pad frames need work');
  const ref = (m[6].match(/\(fp_text reference "([^"]+)"/) || [])[1];
  const pads = [];
  for (const p of m[6].matchAll(/\(pad "([^"]+)" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\) \(layers "([^"]+)"[^)]*\)(?: \(clearance [\d.]+\))? \(net (\d+) "([^"]*)"\)\)/g)) {
    pads.push({ name: p[1], x: +m[3] + +p[2], y: +m[4] + +p[3], deg: +(p[4] || 0), w: +p[5], h: +p[6], layer: p[7], net: p[9] });
  }
  fps.push({ ref, pads });
}
const padLayer = LI.get('B.Cu');
for (const fp of fps) for (const p of fp.pads) {
  if (p.layer !== 'B.Cu') throw new Error(`pad on ${p.layer}`);
  if (!inPeriod(p.x, p.y)) continue;
  R.addStatic(padLayer, { t: 'rect', x: p.x, y: p.y, w: p.w, h: p.h, deg: p.deg }, classOfPad(p.net, p.name)); nStat++;
}
// windings and tabs: straight segments and fillet arcs, every copper layer
const arcPts = (sx, sy, mx, my, ex, ey) => {
  const d = 2 * (sx * (my - ey) + mx * (ey - sy) + ex * (sy - my));
  if (Math.abs(d) < 1e-12) return [[sx, sy], [ex, ey]];
  const ux = ((sx * sx + sy * sy) * (my - ey) + (mx * mx + my * my) * (ey - sy) + (ex * ex + ey * ey) * (sy - my)) / d;
  const uy = ((sx * sx + sy * sy) * (ex - mx) + (mx * mx + my * my) * (sx - ex) + (ex * ex + ey * ey) * (mx - sx)) / d;
  const r = Math.hypot(sx - ux, sy - uy);
  let a0 = Math.atan2(sy - uy, sx - ux), a1 = Math.atan2(my - uy, mx - ux), a2 = Math.atan2(ey - uy, ex - ux);
  const norm = (a) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
  const ccw = norm(a1 - a0) < norm(a2 - a0);
  const sweep = ccw ? norm(a2 - a0) : -norm(a0 - a2);
  // chords sag INSIDE the arc: keep the sagitta under half a micron, or copper
  // routed along a winding's corner fillet sits that much closer than modelled
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - 0.0005 / r)))));
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push([ux + r * Math.cos(a0 + (sweep * k) / n), uy + r * Math.sin(a0 + (sweep * k) / n)]);
  return pts;
};
const prim = (layer, ax, ay, bx, by, w, name) => {
  if (!inPeriod((ax + bx) / 2, (ay + by) / 2)) return;
  if (!/^coil_/.test(name)) throw new Error(`unexpected static track on net ${name}`);
  const li = LI.get(layer);
  R.addStatic(li ?? 0, { t: 'seg', ax, ay, bx, by, r: w / 2 }, BLOCK, { viaOnly: li === undefined }); nStat++;
};
for (const m of txt.matchAll(/^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "([^"]+)"\) \(net (\d+)\)\)/gm)) {
  prim(m[6], +m[1], +m[2], +m[3], +m[4], +m[5], netName.get(+m[7]));
}
for (const m of txt.matchAll(/^  \(arc \(start ([-\d.]+) ([-\d.]+)\) \(mid ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "([^"]+)"\) \(net (\d+)\)\)/gm)) {
  const pts = arcPts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  const mid = pts[pts.length >> 1];
  if (!inPeriod(mid[0], mid[1])) continue;
  const li = LI.get(m[8]);
  for (let k = 0; k + 1 < pts.length; k++) {
    R.addStatic(li ?? 0, { t: 'seg', ax: pts[k][0], ay: pts[k][1], bx: pts[k + 1][0], by: pts[k + 1][1], r: +m[7] / 2 }, BLOCK, { viaOnly: li === undefined });
  }
  nStat++;
}

// ---- fixed lanes: the In12 runs of the bus nets, from an existing session --------
const lanes = [];                                  // {net, pts:[[x,y]...]} board mm
{
  const ses = readFileSync(LANES, 'utf8');
  const res = ses.match(/\(resolution (\w+) (\d+)\)/);
  const scale = ((res ? res[1] : 'um') === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
  for (const nm of ses.slice(ses.indexOf('(network_out')).matchAll(/\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g)) {
    const g = nm[1].replace(/_C$/, '');
    if (!GLOBALS.includes(g) || !nm[1].endsWith('_C')) continue;
    for (const w of nm[2].matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
      if (w[1] !== 'In12.Cu') continue;
      const n = w[3].trim().split(/\s+/).map(Number), pts = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i] * scale, -n[i + 1] * scale]);
      lanes.push({ net: g, pts, width: +w[2] * scale });
    }
  }
}
// RESERVED through-lanes: straight E-W In12 runs across the whole period on
// lines that clear every barrel of the bare board (measured: the band-boundary
// gap holds two, 0.385 mm of clean line at 10.02 mm north of the S row). The
// stamp must leave them empty; the assembler lays copper on them only where
// the board needs a long east-west net -- the DATA chain's band-to-band
// returns -- which nothing can route through 100 mm of finished stamps
// otherwise (measured: "no path" on every layer).
//   RESERVE="dy,dy" offsets from the S-row centre (file frame, north negative)
const reserve = (process.env.RESERVE ?? '-10.19,-9.84').split(',').filter(Boolean).map(Number);
reserve.forEach((dy, k) => {
  const y = c0y + dy;
  for (const v of vias) if (inPeriod(v.x, v.y) && Math.abs(v.y - y) < v.r + RULE.clr + RULE.track / 2) throw new Error(`reserved lane ${k + 1} at y ${y.toFixed(3)} is ${Math.abs(v.y - y).toFixed(3)} from a barrel at ${v.x},${v.y}`);
  lanes.push({ net: `RET${k + 1}`, pts: [[X0, y], [X0 + AX, y]], width: RULE.track, reserve: true });
});
const in12 = LI.get('In12.Cu');
const laneNodes = new Map(GLOBALS.map((g) => [g, new Map()]));   // net -> Map node -> [iu, ju]
for (const ln of lanes) {
  for (let k = 0; k + 1 < ln.pts.length; k++) {
    const [ax, ay] = ln.pts[k], [bx, by] = ln.pts[k + 1];
    R.addStatic(in12, { t: 'seg', ax, ay, bx, by, r: ln.width / 2 }, R.cls(ln.net), { track: true });
    if (!ln.reserve) R.rasterCapsule(ax, ay, bx, by, 0.6 * R.h, (c) => laneNodes.get(ln.net).set(in12 * R.nxy + c, [c % nx, (c / nx) | 0]));
  }
}
console.log(`static: ${nStat} primitives in one period, ${lanes.length} fixed lane runs  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ---- pins (the centre quad's real items, in unwrapped grid coords) ---------------
const exact = new Map();                           // cell -> exact barrel centre (canonical image)
const viaNodes = (x, y) => {
  const iu = R.ix(x), ju = R.jy(y), c = R.cell(iu, ju);
  const ic = c % nx, jc = (c / nx) | 0;
  exact.set(c, [x + (ic - iu) * R.hx, y + (jc - ju) * R.hy]);
  R.viaCells.add(c);
  return layers.map((_, l) => [l, iu, ju]);
};
const padNodes = (p) => {
  const out = [], a = (p.deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const w = p.w / 2 - 0.03, h = p.h / 2 - 0.03, Rr = Math.hypot(p.w, p.h) / 2;
  for (let ju = R.jy(p.y - Rr); ju <= R.jy(p.y + Rr); ju++) for (let iu = R.ix(p.x - Rr); iu <= R.ix(p.x + Rr); iu++) {
    const dx = X0 + iu * R.hx - p.x, dy = Y0 + ju * R.hy - p.y;
    if (Math.abs(dx * ca - dy * sa) <= w && Math.abs(dx * sa + dy * ca) <= h) out.push([padLayer, iu, ju]);
  }
  if (!out.length) throw new Error('pad with no grid node');
  return out;
};
const fpOf = (ref) => fps.find((f) => f.ref === ref) || (() => { throw new Error(`no ${ref}`); })();
const padOf = (ref, name) => fpOf(ref).pads.find((p) => p.name === name);
const SR = fpOf(`SR${centreQuad}`);
const STRIP = Math.ceil(0.6 / R.h);
const windowCut = (groups) => {
  let i0 = 1e9, i1 = -1e9, j0 = 1e9, j1 = -1e9;
  for (const g of groups) for (const [, iu, ju] of g.nodes) { i0 = Math.min(i0, iu); i1 = Math.max(i1, iu); j0 = Math.min(j0, ju); j1 = Math.max(j1, ju); }
  const wI = nx - STRIP, wJ = ny - STRIP;
  const mI = (wI - (i1 - i0)) / 2, mJ = (wJ - (j1 - j0)) / 2;
  return { cut: { i0: Math.floor(i1 + mI) + 1, ilen: STRIP, j0: Math.floor(j1 + mJ) + 1, jlen: STRIP }, margin: Math.min(mI * R.hx, mJ * R.hy) };
};
const sesName = new Map();
const add2 = (name, ses, cls, gA, gB, extra = {}) => {
  const groups = [{ name: 'a', nodes: gA }, { name: 'b', nodes: gB }];
  const { cut, margin } = windowCut(groups);
  if (margin < 0.4) console.log(`WARNING ${name}: window margin ${margin.toFixed(2)} mm`);
  const net = R.addNet({ name, cls: R.cls(cls), groups, tree: [0], jobs: [{ from: [0], to: 1 }], cut, ...extra });
  sesName.set(net, ses);
  return net;
};
const seamVia = (cell, sig, dxCells) => {         // ladder via east of `cell` (+dx pitches)
  const s = { DATA: [3.83, -2.10] }[sig];
  const x = coilF[cell][0] + s[0] + dxCells * pitch, y = coilF[cell][1] - s[1];
  const v = vias.find((q) => Math.hypot(q.x - x, q.y - y) < 0.02);
  if (!v) throw new Error(`no ${sig} seam via at ${x.toFixed(3)},${y.toFixed(3)}`);
  return v;
};
Q.cells.forEach((ci, k) => {
  const U = fpOf(`U${ci}`);
  for (const ab of ['A', 'B']) {
    const nm = `PWM${ab}_${ci}`;
    add2(nm, nm, `PWM${ab}_k${k}`, padNodes(SR.pads.find((p) => p.net === nm)), padNodes(U.pads.find((p) => p.net === nm)));
  }
  const [ccx, ccy] = coilF[ci];
  ['A', 'B'].forEach((ab, t) => {
    const vx = ccx + termOff[t][0], vy = ccy + termOff[t][1];
    const v = vias.find((q) => Math.hypot(q.x - vx, q.y - vy) < 0.05);
    add2(`coil_${ci}_${ab}`, `coil_${ci}_${ab}`, `coil${ab}_k${k}`, viaNodes(v.x, v.y), padNodes(padOf(`U${ci}`, ab === 'A' ? '2' : '6')));
  });
});
{
  const dv = R.cls('DATA_V');
  const vE = seamVia(Q.cells[1], 'DATA', 0), vW = seamVia(Q.cells[0], 'DATA', -1);
  add2('DATA_E', 'DATA_E', 'DATA_E', padNodes(padOf(SR.ref, '2')), viaNodes(vE.x, vE.y), { allow: [dv] });
  add2('DATA_W', 'DATA_W', 'DATA_W', viaNodes(vW.x, vW.y), padNodes(padOf(SR.ref, '12')), { allow: [dv] });
}
const quadRefs = [SR.ref, ...Q.cells.flatMap((c) => [`U${c}`, `C${c}`])];
// MESH: link each bus net's two lane rows north-south INSIDE the stamp, once
// across the quad (S row -> N row) and once across the band boundary (N row ->
// the next band's S row). Tiled, that makes every bus net one connected mesh
// with no margin spines at all. Each link gets a y-window so it has to go the
// stated way round the torus.
const MESH = +(process.env.MESH || 0);
const rowH = Math.abs(coilF[Q.cells[2]][1] - c0y);
const laneOff = { VBUS: -0.42, GND: 0.42, VLOGIC: 1.68, SDA: 1.26, SCL: 2.10, SCLK: -1.26, RCLK: -1.68, OE_N: -2.52 };
const busNets = ['GND', 'VBUS', 'VLOGIC', 'SCLK', 'RCLK', 'OE_N', ...(MESH > 1 ? ['SDA', 'SCL'] : [])];
for (const g of busNets) {
  const fixed = [...laneNodes.get(g)].map(([n, [iu, ju]]) => [(n / R.nxy) | 0, iu, ju]);
  for (const v of vias) if (v.net === g && inPeriod(v.x, v.y) && v.x < X0 + AX - EPS && v.y < Y0 + BY - EPS) fixed.push(...viaNodes(v.x, v.y));
  const yOf = (ju) => Y0 + ju * R.hy;
  const isS = (ju) => Math.abs(yOf(ju) - c0y) < rowH / 2;
  const groups = [{ name: 'lanesS', nodes: fixed.filter((p) => isS(p[2])) }, { name: 'lanesN', nodes: fixed.filter((p) => !isS(p[2])) }];
  const jobs = [];
  if (MESH) {
    const yS = c0y - laneOff[g], yN = yS - rowH, m = 0.3;
    const a0 = R.jy(yS + m) + 1, aLen = ny - (R.jy(yS + m) - R.jy(yN - m) + 1);
    const b0 = R.jy(yN + m) + 1, bLen = R.jy(yS - m) - R.jy(yN + m) - 1;
    // a link starts and ends on ladder barrels, which reach every layer for
    // free: steer it onto the winding-layer gutters and leave B.Cu to the
    // nets that have no other way out of their pads
    const lcLink = layers.map((l) => (l === 'B.Cu' ? +(process.env.LINK_BCU || 4) : l === 'In12.Cu' ? 2 : 1));
    jobs.push({ from: [0], to: 1, cut: { j0: a0, jlen: aLen }, layerCost: lcLink });
    jobs.push({ from: [1], to: 0, cut: { j0: b0, jlen: bLen }, layerCost: lcLink });
  }
  for (const ref of quadRefs) for (const p of fpOf(ref).pads) {
    if (p.net !== g) continue;
    groups.push({ name: `${ref}.${p.name}`, nodes: padNodes(p) });
    jobs.push({ from: 'tree', to: groups.length - 1 });
  }
  const net = R.addNet({ name: g, cls: R.cls(g), groups, tree: [0, 1], jobs });
  sesName.set(net, `${g}_C`);
}
console.log(`nets: ${R.nets.length}, jobs: ${R.nets.reduce((t, n) => t + n.jobs.length, 0)}`);

// ---- route ----------------------------------------------------------------------
const res = R.negotiate({ maxIter: +(process.env.ITERS || 60), pfMax: +(process.env.PFMAX || 40), histStep: +(process.env.HIST || 0.35), seed: +(process.env.SEED || 1) });
if (res.ok) {
  R.polish(3);
  for (let r = 0; r < 2; r++) for (const net of R.nets) R.smooth(net);
  const still = R.nets.filter((n) => R.conflicts(n).length);
  console.log(still.length ? `POST-PROCESS BROKE: ${still.map((n) => n.name).join(',')}` : 'polish + smooth: still conflict-free');
}
if (process.env.DBG) for (const net of R.nets) {
  const bad = R.conflicts(net);
  if (!bad.length) continue;
  const by = new Map();
  for (const n of bad) { const l = (n / R.nxy) | 0, c = n % R.nxy; const k = `${layers[l]} ${(X0 + (c % nx) * R.hx).toFixed(1)},${(Y0 + ((c / nx) | 0) * R.hy).toFixed(1)}`; by.set(k, (by.get(k) || 0) + 1); }
  console.log(`  ${net.name}: ${bad.length} conflict nodes: ${[...by].slice(0, 6).map(([k, v]) => `${k} x${v}`).join(' | ')}`);
}
console.log(res.ok ? `CONVERGED in ${res.iters} iterations` : `NOT converged; still fighting: ${res.left.join(', ')}`);

// ---- out --------------------------------------------------------------------------
const U = (v) => Math.round(v * 10000);
const blocks = [];
const dump = { x0: X0, y0: Y0, ax: AX, by: BY, nets: [] };
const laneByNet = new Map();
for (const ln of lanes) { if (ln.reserve) continue; if (!laneByNet.has(ln.net)) laneByNet.set(ln.net, []); laneByNet.get(ln.net).push(ln); }
const emitted = new Set();
for (const net of R.nets) {
  const geo = netGeometry(R, net, exact);
  const name = sesName.get(net);
  const w = [];
  const g = name.replace(/_C$/, '');
  if (name.endsWith('_C')) for (const ln of laneByNet.get(g) || []) w.push(`        (wire\n          (path In12.Cu ${U(ln.width)} ${ln.pts.map(([x, y]) => `${U(x)} ${U(-y)}`).join('  ')}\n          )\n        )`);
  emitted.add(g);
  for (const s of geo.segs) w.push(`        (wire\n          (path ${s.layer} ${U(RULE.track)} ${U(s.a[0])} ${U(-s.a[1])}  ${U(s.b[0])} ${U(-s.b[1])}\n          )\n        )`);
  for (const v of geo.vias) w.push(`        (via "Via[0-13]_500:230_um" ${U(v[0])} ${U(-v[1])}\n        )`);
  blocks.push(`(net ${name}\n${w.join('\n')}\n      )`);
  dump.nets.push({ name, segs: geo.segs, vias: geo.vias, failed: net.failed.map((j) => net.groups[j.to].name) });
}
for (const [g, lns] of laneByNet) {                 // SDA / SCL: lanes only
  if (emitted.has(g)) continue;
  blocks.push(`(net ${g}_C\n${lns.map((ln) => `        (wire\n          (path In12.Cu ${U(ln.width)} ${ln.pts.map(([x, y]) => `${U(x)} ${U(-y)}`).join('  ')}\n          )\n        )`).join('\n')}\n      )`);
}
const head = `(session ${B}.t2\n  (base_design ${B}.t2)\n  (placement\n    (resolution um 10)\n  )\n  (was_is\n  )\n  (routes \n    (resolution um 10)\n    (parser\n      (host_cad "stamp2.mjs")\n    )\n    (library_out \n    )\n    `;
writeFileSync(OUT, `${head}(network_out\n${blocks.join('\n')}\n      )\n    )\n)\n`);
console.log(`wrote ${OUT}`);
if (process.env.DUMP) {
  dump.lanes = lanes;
  // the routed paths as grid nodes, for assemble.mjs: [layerName, iu, ju] in
  // this torus' own (unwrapped) frame, + which steps are new vias
  dump.grid = { x0: X0, y0: Y0, hx: R.hx, hy: R.hy, nx, ny, centreQuad };
  dump.paths = R.nets.flatMap((net) => net.paths.map((p) => ({
    net: sesName.get(net), to: net.groups[p.job.to].name, link: !!p.job.layerCost,
    nodes: Array.from(p.nodes, (n, k) => [layers[(n / R.nxy) | 0], p.unw[2 * k], p.unw[2 * k + 1]]), via: Array.from(p.via),
  })));
  writeFileSync(process.env.DUMP, JSON.stringify(dump));
}
const unrouted = R.nets.filter((n) => n.failed.length).map((n) => `${n.name}(${n.failed.map((j) => n.groups[j.to].name).join(',')})`);
if (unrouted.length) console.log(`UNROUTED jobs: ${unrouted.join(' ')}`);
process.exit(res.ok && !unrouted.length ? 0 : 2);
