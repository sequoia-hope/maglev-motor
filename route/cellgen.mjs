// Build the PERIODIC-CELL experiment board: an n x n amzhex tile rearranged so
// every cell is identical and self-contained, then hand it to cellroute.mjs as
// a single-cell routing problem (route the CENTRE cell, neighbours as
// obstacles).
//
//   * the once-per-board service parts (dead-man, spine header), the
//     one-register-per-four-coils 595s, AND the per-cell bridges/decaps are
//     stripped -- placement is the experiment's degree of freedom, so the
//     bridge, decap and register are placed fresh, ONE arrangement stamped in
//     every cell;
//   * every cell gets its OWN register (74HC595BQ, DHVQFN-16): 2 of its 8
//     outputs drive the cell's bridge, all cells identical, DATA chains
//     west -> east in every row (row ends are a board-margin concern);
//   * every interior vertical seam gets a SEAM VIA LADDER: nine plated
//     through-vias in the shared gutter at fixed cell-frame offsets, one per
//     bus signal (VBUS GND VLOGIC SCLK RCLK OE_N DATA + reserved SDA SCL).
//     They are the whole cell-to-cell interface; diagonal seams carry nothing.
//
// Placement is a sequential cost-guided search (bridge, then decap, then
// register) against the REAL obstacle field: every via land (crossovers,
// terminals, seam vias), every J pad, previously placed parts, and each
// candidate's own periodic copies on the triangular lattice.
import { readFileSync, writeFileSync } from 'fs';
import { buildTile, FOOTPRINTS, FAB, fabRuleFiles, pcbCoilGeometry, viaSize, viaDrill } from '../src/kicad.js';
import { makeStator } from '../src/coils.js';
import { readBoard } from './mkdsn.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

const key = process.argv[2] || 'amzhex';
const n = +(process.argv[3] || 3);
const outKey = process.env.OUT_KEY || 'cellexp';
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));

// --- the seam interface -----------------------------------------------------
// Cell-frame (y-up, coil centre origin) offsets of the seam vias on a cell's
// EAST seam: two staggered columns in the shared gutter (coil flats at ±3.49,
// seam at 4.233), pairwise >= 0.59 mm and clear of the terminal via at
// (3.781,-1.955), the E crossover at (3.781,0.178) and the east neighbour's
// W crossover at (4.686,-1.244). Verified against the real board below.
import { SEAM_SIGNALS } from './cellspec.mjs';
const anchorOf = Object.fromEntries(SEAM_SIGNALS.map((s) => [s.net, s.at]));

// --- build the tile and strip everything placement will redo ----------------
cfg.stator.statorSize = n * cfg.stator.coilPitch;
const t = buildTile(cfg, n);
let txt = t.text;
{
  const stripRe = /^(SR\d+|RDM\d+|CDM\d+|QDM\d+|JSPINE|U\d+|C\d+)$/;
  const blocks = [...txt.matchAll(/  \(footprint "maglev:[^"]+" \(layer "[^"]+"\) \(at [^)]*\)[\s\S]*?\n  \)\n/g)];
  let removed = 0;
  for (const m of blocks) {
    const ref = (m[0].match(/\(fp_text reference "([^"]+)"/) || [])[1] || '';
    if (stripRe.test(ref)) { txt = txt.replace(m[0], ''); removed++; }
  }
  console.log(`stripped ${removed} footprints (service, registers, bridges, decaps)`);
}

// --- net table: ensure the chain + reserved nets exist ----------------------
const netOf = new Map();
for (const m of txt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netOf.set(m[2], +m[1]);
let nextNet = Math.max(...netOf.values()) + 1;
const needNets = ['SDA', 'SCL'];
for (let k2 = 0; k2 <= n * n; k2++) needNets.push(`DATA_${k2}`);
const newDecls = [];
for (const nm of needNets) {
  if (!netOf.has(nm)) { netOf.set(nm, nextNet); newDecls.push(`  (net ${nextNet} "${nm}")`); nextNet++; }
}
if (newDecls.length) {
  const lastDecl = [...txt.matchAll(/^  \(net \d+ "[^"]*"\)$/gm)].pop();
  txt = txt.slice(0, lastDecl.index + lastDecl[0].length) + '\n' + newDecls.join('\n')
    + txt.slice(lastDecl.index + lastDecl[0].length);
}

// --- geometry ----------------------------------------------------------------
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const g = pcbCoilGeometry(cfg);
const pitch = cfg.stator.coilPitch * 1000;
const cellHalf = pitch / 2;
const vSize = viaSize(g, cellHalf);
const vDrill = viaDrill(vSize, g.thickness);
const CLR = FAB.minClearance, rV = vSize / 2;
const coilKeepR = g.halfOut + g.trace / 2;

const tmpPath = new URL(`./${outKey}.tmp.kicad_pcb`, import.meta.url);
writeFileSync(tmpPath, txt);
const board = readBoard(tmpPath.pathname);

let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coils = stator.coils.map((c) => ({ fx: cx0 + c.x * 1000, fy: cy0 - c.y * 1000, wx: c.x * 1000, wy: c.y * 1000 }));

// Chain order: rows bottom-to-top (world y), west-to-east in EVERY row.
const rowKey = (c) => +c.wy.toFixed(3);
const rowsYs = [...new Set(coils.map(rowKey))].sort((a, b) => a - b);
const rowIdx = new Map(rowsYs.map((y, i2) => [y, i2]));
const order = coils.map((c, i2) => ({ i: i2, row: rowIdx.get(rowKey(c)), x: c.wx }))
  .sort((a, b) => a.row - b.row || a.x - b.x);
const chainK = new Map(order.map((o, k2) => [o.i, k2]));
let centre = 0, dBest = 1e9;
stator.coils.forEach((c, i2) => { const d = Math.hypot(c.x, c.y); if (d < dBest) { dBest = d; centre = i2; } });
const cc = coils[centre];

// --- verify + collect the seam vias -----------------------------------------
const hexDist = (dx, dy) => {
  let m = -1e9;
  for (let k2 = 0; k2 < 6; k2++) {
    const a = (k2 * Math.PI) / 3;
    m = Math.max(m, dx * Math.cos(a) + dy * Math.sin(a));
  }
  return m;
};
const seamOK = (fx, fy) => {
  for (const c of coils) {
    const dx = fx - c.fx, dy = -(fy - c.fy);
    if (Math.hypot(dx, dy) > pitch * 1.2) continue;
    if (hexDist(dx, dy) < coilKeepR + CLR + rV) return `coil copper`;
  }
  for (const v of board.vias) {
    const d = Math.hypot(fx - v.x, fy - v.y);
    if (d < vSize + CLR && d > 1e-6) return `via ${v.x.toFixed(2)},${v.y.toFixed(2)}`;
  }
  for (const fp of board.fps) for (const pd of fp.pads) {
    // exact distance to the rotated pad rectangle, not its bounding circle
    const a = (pd.ang * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const dx = fx - (fp.x + pd.dx), dy = fy - (fp.y + pd.dy);
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const qx = Math.max(Math.abs(lx) - pd.w / 2, 0), qy = Math.max(Math.abs(ly) - pd.h / 2, 0);
    if (Math.hypot(qx, qy) < CLR + rV) return `pad ${fp.ref}.${pd.name}`;
  }
  if (fx - minX < 0.45 || maxX - fx < 0.45 || fy - minY < 0.45 || maxY - fy < 0.45) return 'board edge';
  return null;
};
const eastOf = new Map();
for (const [i2, c] of coils.entries()) {
  const j = coils.findIndex((d) => Math.abs(d.wx - c.wx - pitch) < 0.01 && Math.abs(d.wy - c.wy) < 0.01);
  if (j >= 0) eastOf.set(i2, j);
}
const seamVias = [];
let seamBad = 0;
for (const [i2, j] of eastOf) {
  for (const s of SEAM_SIGNALS) {
    const fx = coils[i2].fx + s.at[0], fy = coils[i2].fy - s.at[1];
    const bad = seamOK(fx, fy);
    if (bad) { console.log(`seam ${i2}->${j} ${s.net}: BLOCKED by ${bad}`); seamBad++; continue; }
    const name = s.net === 'DATA' ? `DATA_${chainK.get(j)}` : s.net;
    seamVias.push({ fx, fy, netNum: netOf.get(name), netName: name });
  }
}
for (let a = 0; a < seamVias.length; a++) for (let b = a + 1; b < seamVias.length; b++) {
  const d = Math.hypot(seamVias[a].fx - seamVias[b].fx, seamVias[a].fy - seamVias[b].fy);
  if (d < vSize + CLR) { console.log(`seam via pair too close: ${d.toFixed(2)}`); seamBad++; }
}
console.log(`seam vias: ${seamVias.length} placed, ${seamBad} problems`);
if (seamBad) process.exit(1);

// --- placement search machinery ---------------------------------------------
// All in the centre cell's frame (world mm, y up). Obstacles carry lattice
// images implicitly: tests run against [0,0] plus the six neighbour offsets.
const latt = [[pitch, 0], [-pitch, 0], [pitch / 2, pitch * Math.sqrt(3) / 2], [pitch / 2, -pitch * Math.sqrt(3) / 2], [-pitch / 2, pitch * Math.sqrt(3) / 2], [-pitch / 2, -pitch * Math.sqrt(3) / 2]];
const rot2 = (px, py, c, s) => [px * c - py * s, px * s + py * c];
const rcOverlap = (a, b, grow) => {
  const test = (p, q, pg, qg) => {
    const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
    const dx = q.cx - p.cx, dy = q.cy - p.cy;
    const qx = dx * ca + dy * sa, qy = -dx * sa + dy * ca;
    const rel = q.ang - p.ang, cr = Math.abs(Math.cos(rel)), sr = Math.abs(Math.sin(rel));
    const qw = q.w / 2 + qg, qh = q.h / 2 + qg;
    return Math.abs(qx) <= p.w / 2 + pg + cr * qw + sr * qh && Math.abs(qy) <= p.h / 2 + pg + sr * qw + cr * qh;
  };
  return test(a, b, 0, grow) && test(b, a, grow, 0);
};
const circHit = (r2, cx2, cy2, rad) => {
  const c = Math.cos(r2.ang), s = Math.sin(r2.ang), dx = cx2 - r2.cx, dy = cy2 - r2.cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.max(Math.abs(lx) - r2.w / 2, 0), qy = Math.max(Math.abs(ly) - r2.h / 2, 0);
  return qx * qx + qy * qy <= rad * rad;
};
// Base obstacle field: every via land (incl. seam vias) and every remaining
// pad (the J terminal pads) anywhere near the centre cell.
const discs = [];
for (const v of board.vias) {
  const dx = v.x - cc.fx, dy = -(v.y - cc.fy);
  if (Math.hypot(dx, dy) < pitch * 1.8) discs.push({ x: dx, y: dy, r: v.size / 2 });
}
for (const s2 of seamVias) {
  const dx = s2.fx - cc.fx, dy = -(s2.fy - cc.fy);
  if (Math.hypot(dx, dy) < pitch * 1.8) discs.push({ x: dx, y: dy, r: vSize / 2 });
}
const baseRects = [];
for (const fp of board.fps) {
  for (const pd of fp.pads) {
    const rx2 = fp.x + pd.dx - cc.fx, ry2 = -(fp.y + pd.dy - cc.fy);
    if (Math.hypot(rx2, ry2) > pitch * 1.8) continue;
    baseRects.push({ cx: rx2, cy: ry2, w: pd.w, h: pd.h, ang: (pd.ang * Math.PI) / 180 });
  }
}
const placedRects = [];   // pads+bodies of parts placed so far (cell frame); images added at test time
const partFits = (fp, rx, ry, ang, clr) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  const pads = fp.pads.map(([px, py, w, h]) => {
    const [qx, qy] = rot2(px, py, c, s);
    return { cx: rx + qx, cy: ry + qy, w, h, ang };
  });
  const bodyR = { cx: rx, cy: ry, w: fp.body[0], h: fp.body[1], ang, body: true };
  for (const pr of pads) {
    for (const d of discs) if (circHit(pr, d.x, d.y, d.r + clr)) return false;
    for (const [ox, oy] of [[0, 0], ...latt]) {
      for (const r2 of baseRects) if (rcOverlap(pr, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
      for (const r2 of placedRects) if (rcOverlap(pr, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
    }
  }
  // body: parts cannot share air with other parts (incl. periodic images of
  // this very part) or sit over pads; tented vias under the body are fine.
  for (const [ox, oy] of [[0, 0], ...latt]) {
    for (const r2 of placedRects) if (rcOverlap(bodyR, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
    for (const r2 of baseRects) if (rcOverlap(bodyR, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
  }
  const ex = Math.max(fp.body[0] / 2, ...fp.pads.map(([px, , w]) => Math.abs(px) + w / 2));
  const ey = Math.max(fp.body[1] / 2, ...fp.pads.map(([, py, , h]) => Math.abs(py) + h / 2));
  const ext = { cx: rx, cy: ry, w: 2 * ex, h: 2 * ey, ang };
  for (const [ox, oy] of latt) if (rcOverlap(ext, { ...ext, cx: rx + ox, cy: ry + oy }, clr)) return false;
  return true;
};
const search = (fp, costFn, { rotStep = 30, span = 3.6, override, clrLadder } = {}) => {
  // OVERRIDE ("x,y,rot" from the environment): trust the caller, verify it fits
  // at the best clearance that accepts it, and report that clearance honestly.
  if (override) {
    const [rx, ry, rdeg] = override.split(',').map(Number);
    for (const clr of [0.30, 0.25, 0.20, 0.15, 0.12, 0.09]) {
      if (partFits(fp, rx, ry, (rdeg * Math.PI) / 180, clr)) {
        return { rx, ry, rdeg, clr, cost: costFn(rx, ry, (rdeg * Math.PI) / 180), forced: true };
      }
    }
    console.log(`override ${override} DOES NOT FIT`);
    return null;
  }
  let best = null;
  const all = [];
  for (const clr of clrLadder || [0.30, 0.25, 0.20, 0.15, 0.12, 0.09]) {
    for (let rx = -span; rx <= span; rx += 0.1) {
      for (let ry = -span - 1.2; ry <= span + 1.2; ry += 0.1) {
        for (let rdeg = 0; rdeg < 360; rdeg += rotStep) {
          const ang = (rdeg * Math.PI) / 180;
          if (!partFits(fp, rx, ry, ang, clr)) continue;
          const cost = costFn(rx, ry, ang);
          all.push({ rx, ry, rdeg, clr, cost });
          if (!best || cost < best.cost) best = { rx, ry, rdeg, clr, cost };
        }
      }
    }
    if (best) break;
  }
  if (best && process.env.PRINT_CANDS) {
    // Diverse representatives: bucket by 0.8 mm position cell, keep each
    // bucket's cheapest, print the ten cheapest buckets.
    const byCell = new Map();
    for (const c of all) {
      const k2 = `${Math.round(c.rx / 0.8)},${Math.round(c.ry / 0.8)}`;
      if (!byCell.has(k2) || c.cost < byCell.get(k2).cost) byCell.set(k2, c);
    }
    const reps = [...byCell.values()].sort((a, b) => a.cost - b.cost).slice(0, 10);
    console.log('candidates: ' + reps.map((c) => `${c.rx.toFixed(1)},${c.ry.toFixed(1)},${c.rdeg}(${c.cost.toFixed(1)})`).join('  '));
  }
  return best;
};
const commit = (fp, pl) => {
  const c = Math.cos((pl.rdeg * Math.PI) / 180), s = Math.sin((pl.rdeg * Math.PI) / 180);
  for (const [px, py, w, h] of fp.pads) {
    const [qx, qy] = rot2(px, py, c, s);
    placedRects.push({ cx: pl.rx + qx, cy: pl.ry + qy, w, h, ang: (pl.rdeg * Math.PI) / 180 });
  }
  placedRects.push({ cx: pl.rx, cy: pl.ry, w: fp.body[0], h: fp.body[1], ang: (pl.rdeg * Math.PI) / 180 });
};
const padAt = (fp, pl, idx) => {
  const c = Math.cos((pl.rdeg * Math.PI) / 180), s = Math.sin((pl.rdeg * Math.PI) / 180);
  const [qx, qy] = rot2(fp.pads[idx][0], fp.pads[idx][1], c, s);
  return [pl.rx + qx, pl.ry + qy];
};
const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// --- 1. bridge ---------------------------------------------------------------
// sot23hb pad order (emitBridge6): 1 in1, 2 outa, 3 gnd, 4 vbus, 5 in2, 6 outb.
// Fixed cell landmarks (measured off the board, cell frame y-up):
const J_IN = [3.781, -1.955], J_OUT = [1.736, -3.363];
const SRZONE = [-1.6, 0.2];   // where the register is expected to live (W half)
const fpU = FOOTPRINTS.sot23hb;
const plU = search(fpU, (rx, ry, ang) => {
  const pl = { rx, ry, rdeg: (ang * 180) / Math.PI };
  return d2(padAt(fpU, pl, 1), J_IN) + d2(padAt(fpU, pl, 5), J_OUT)
    + 0.6 * d2(padAt(fpU, pl, 3), anchorOf.VBUS) + 0.6 * d2(padAt(fpU, pl, 2), anchorOf.GND)
    + 0.4 * (d2(padAt(fpU, pl, 0), SRZONE) + d2(padAt(fpU, pl, 4), SRZONE));
}, { override: process.env.U_AT });
if (!plU) { console.log('NO bridge placement'); process.exit(1); }
commit(fpU, plU);
console.log(`bridge at (${plU.rx.toFixed(1)}, ${plU.ry.toFixed(1)}) rot ${plU.rdeg} clr ${plU.clr} cost ${plU.cost.toFixed(1)}`);

// --- 2. decap ----------------------------------------------------------------
const fpC = { label: '0402 decap', body: [1.0, 0.5], pads: [[-0.5, 0, 0.5, 0.4], [0.5, 0, 0.5, 0.4]] };
const uVBUS = padAt(fpU, plU, 3), uGND = padAt(fpU, plU, 2);
const plC = search(fpC, (rx, ry, ang) => {
  const pl = { rx, ry, rdeg: (ang * 180) / Math.PI };
  return d2(padAt(fpC, pl, 0), uVBUS) + d2(padAt(fpC, pl, 1), uGND)
    + 0.3 * d2(padAt(fpC, pl, 0), anchorOf.VBUS) + 0.3 * d2(padAt(fpC, pl, 1), anchorOf.GND);
}, { rotStep: 90, override: process.env.C_AT });
if (!plC) { console.log('NO decap placement'); process.exit(1); }
commit(fpC, plC);
console.log(`decap at (${plC.rx.toFixed(1)}, ${plC.ry.toFixed(1)}) rot ${plC.rdeg} clr ${plC.clr} cost ${plC.cost.toFixed(1)}`);

// --- 3. register -------------------------------------------------------------
// qfn16 pad indices (0-based): 0 gnd, 11 ds, 1 q7s, 13 q0(PWMA), 14 q1(PWMB),
// 15 vcc, 5 sclk(idx?): pad k -> function (k%2==0 ? left : right)[k>>1]:
// left [gnd q7 q6 q5 q4 q3 q2 q1] = idx 0,2,4,6,8,10,12,14
// right [q7s mr sclk rclk oen ds q0 vcc] = idx 1,3,5,7,9,11,13,15
const fpS = FOOTPRINTS.qfn16;
const uIN1 = padAt(fpU, plU, 0), uIN2 = padAt(fpU, plU, 4);
const W_DATA = [anchorOf.DATA[0] - pitch, anchorOf.DATA[1]];
const plS = search(fpS, (rx, ry, ang) => {
  const pl = { rx, ry, rdeg: (ang * 180) / Math.PI };
  return d2(padAt(fpS, pl, 13), uIN1) + d2(padAt(fpS, pl, 14), uIN2)
    + 0.8 * d2(padAt(fpS, pl, 11), W_DATA) + 0.8 * d2(padAt(fpS, pl, 1), anchorOf.DATA)
    + 0.5 * d2(padAt(fpS, pl, 0), [anchorOf.GND[0] - pitch, anchorOf.GND[1]])
    + 0.5 * d2(padAt(fpS, pl, 15), [anchorOf.VLOGIC[0] - pitch, anchorOf.VLOGIC[1]])
    + 0.3 * (d2(padAt(fpS, pl, 5), [anchorOf.SCLK[0] - pitch, anchorOf.SCLK[1]])
      + d2(padAt(fpS, pl, 7), [anchorOf.RCLK[0] - pitch, anchorOf.RCLK[1]])
      + d2(padAt(fpS, pl, 9), [anchorOf.OE_N[0] - pitch, anchorOf.OE_N[1]]));
}, { override: process.env.SR_AT, clrLadder: process.env.SR_CLR ? [+process.env.SR_CLR] : undefined });
if (!plS) { console.log('NO register placement'); process.exit(1); }
commit(fpS, plS);
console.log(`register at (${plS.rx.toFixed(1)}, ${plS.ry.toFixed(1)}) rot ${plS.rdeg} clr ${plS.clr} cost ${plS.cost.toFixed(1)}`);

// --- emit everything, identically, per cell ----------------------------------
const f3 = (v) => +v.toFixed(4);
const leftFn = ['gnd', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'];
const rightFn = ['q7s', 'mr', 'sclk', 'rclk', 'oen', 'ds', 'q0', 'vcc'];
const emit = [];
const emitPartText = (lib, value, ref, lcsc, fp, pl, c, netForPad) => {
  const ang = (pl.rdeg * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const fx = c.fx + pl.rx, fy = c.fy - pl.ry;
  emit.push(`  (footprint "maglev:${lib}" (layer "B.Cu") (at ${f3(fx)} ${f3(fy)})`);
  emit.push('    (attr smd)');
  emit.push(`    (fp_text reference "${ref}" (at 0 ${-(fp.body[1] / 2 + 0.7)}) (layer "B.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06)) (justify mirror)))`);
  emit.push(`    (fp_text value "${value}" (at 0 ${fp.body[1] / 2 + 0.7}) (layer "B.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06)) (justify mirror)))`);
  emit.push(`    (property "LCSC" "${lcsc}")`);
  fp.pads.forEach(([px, py, w, h], k3) => {
    const nm = netForPad(k3);
    const [qx, qy] = rot2(px, py, ca, sa);
    const netStr = nm ? `(net ${netOf.get(nm)} "${nm}")` : '(net 0 "")';
    emit.push(`    (pad "${k3 + 1}" smd rect (at ${f3(qx)} ${f3(-qy)}${pl.rdeg ? ` ${f3(pl.rdeg)}` : ''}) (size ${w} ${h}) (layers "B.Cu" "B.Paste" "B.Mask") ${netStr})`);
  });
  emit.push('  )');
};
for (const [i2, c] of coils.entries()) {
  const k2 = chainK.get(i2);
  emitPartText('SOT23HB', 'TC118S', `U${i2}`, 'C88308', fpU, plU, c,
    (k3) => [`PWMA_${i2}`, `coil_${i2}`, 'GND', 'VBUS', `PWMB_${i2}`, `coil_${i2}`][k3]);
  emitPartText('C0402', '100n', `C${i2}`, 'C1525', fpC, plC, c,
    (k3) => ['VBUS', 'GND'][k3]);
  emitPartText('SR595Q', '74HC595BQ', `SR${i2}`, 'C730243', fpS, plS, c, (k3) => {
    const fn = (k3 % 2 === 0 ? leftFn : rightFn)[k3 >> 1];
    if (fn === 'gnd') return 'GND';
    if (fn === 'vcc' || fn === 'mr') return 'VLOGIC';
    if (fn === 'sclk') return 'SCLK';
    if (fn === 'rclk') return 'RCLK';
    if (fn === 'oen') return 'OE_N';
    if (fn === 'ds') return `DATA_${k2}`;
    if (fn === 'q7s') return `DATA_${k2 + 1}`;
    if (fn === 'q0') return `PWMA_${i2}`;
    if (fn === 'q1') return `PWMB_${i2}`;
    return null;
  });
}
const viaText = seamVias.map((v) =>
  `  (via (at ${f3(v.fx)} ${f3(v.fy)}) (size ${vSize}) (drill ${vDrill}) (layers "F.Cu" "B.Cu") (net ${v.netNum}))`);
const endIdx = txt.lastIndexOf(')');
txt = txt.slice(0, endIdx) + emit.join('\n') + '\n' + viaText.join('\n') + '\n' + txt.slice(endIdx);

writeFileSync(new URL(`./${outKey}.kicad_pcb`, import.meta.url), txt);
const rules = fabRuleFiles({ trackWidth: g.trace, boardThickness: g.thickness });
writeFileSync(new URL(`./${outKey}.kicad_dru`, import.meta.url), rules.dru);
writeFileSync(new URL(`./${outKey}.kicad_pro`, import.meta.url), rules.pro);
console.log(JSON.stringify({
  cells: coils.length, centre, chainOrder: order.map((o) => o.i),
  bridge: plU, decap: plC, register: plS, seamVias: seamVias.length,
}, null, 1));
console.log(`wrote ${outKey}.kicad_pcb`);
