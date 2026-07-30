// Build the QUAD-STAMP experiment board: the FULL 12x14 amzhex array arranged
// as 42 identical 2x2-cell quads, each with its own 74HC595BQ driving its four
// bridges (the 6x2 "cluster" is three of these side by side -- the quad is the
// irreducible identical stamp). Every cell gets the same bridge+decap offsets,
// every quad the same register offset, every interior E-W seam the 9-via
// ladder from cellspec. DATA chains quad -> east neighbour in EVERY band
// (returns at the margins are a board-level stage, not a stamp concern).
// Sensors and the dead-man/header are omitted here: they are the board-level
// overlay, placed after the stamps.
import { readFileSync, writeFileSync } from 'fs';
import { buildKiCad, FOOTPRINTS, FAB, fabRuleFiles, pcbCoilGeometry, viaSize, viaDrill } from '../src/kicad.js';
import { makeStator } from '../src/coils.js';
import { readBoard } from './mkdsn.mjs';
// This IS the generator: its own read-back (part placement verification on
// the intermediate board) happens before the coilcheck gate can possibly
// have stamped anything. The gate protects ROUTING tools downstream.
process.env.VALIDATE_SKIP = '1';
import { SEAM_SIGNALS } from './cellspec.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

const key = process.argv[2] || 'amzhex';
const outKey = process.env.OUT_KEY || 'quadexp';
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));
if (process.env.TILE) cfg.stator.statorSize = (+process.env.TILE) * cfg.stator.coilPitch;

const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
// banFlats [0,3]: keep the E/W gutters via-free -- they carry the seam-via
// ladder and the constructed lane runs (cellspec ladder v3); crossover and
// terminal vias park on the diagonal flats instead. banBands keeps those
// vias 0.39 mm clear of every lane run line (lanes at |offset| 1.26..2.52,
// so |y| in [0.85, 2.93] is via-free). No sensorSpacing: no sensors on the
// stamp board.
const VIA_PLAN_OPTS = { banFlats: [0, 3], banBands: [[0.85, 2.93]] };
const kc = buildKiCad(stator, cfg, VIA_PLAN_OPTS);
let txt = kc.text;
console.log(`board: ${stator.coils.length} coils`);

// --- strip everything the stamp will redo -----------------------------------
{
  const stripRe = /^(SR\d+|RDM\d+|CDM\d+|QDM\d+|JSPINE|U\d+|C\d+)$/;
  const blocks = [...txt.matchAll(/  \(footprint "maglev:[^"]+" \(layer "[^"]+"\) \(at [^)]*\)[\s\S]*?\n  \)\n/g)];
  let removed = 0;
  for (const m of blocks) {
    const ref = (m[0].match(/\(fp_text reference "([^"]+)"/) || [])[1] || '';
    if (stripRe.test(ref)) { txt = txt.replace(m[0], ''); removed++; }
  }
  console.log(`stripped ${removed} footprints`);
}

// --- net table ---------------------------------------------------------------
const netOf = new Map();
for (const m of txt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netOf.set(m[2], +m[1]);
let nextNet = Math.max(...netOf.values()) + 1;

// --- geometry / quad lattice -------------------------------------------------
const g = pcbCoilGeometry(cfg);
const pitch = cfg.stator.coilPitch * 1000;
const rowH = pitch * Math.sqrt(3) / 2;
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
// The board file's frame: coil world (0,0) lands at the outline centre --
// recover it from the stator's own extent rather than the (inset) outline.
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coils = stator.coils.map((c) => ({ fx: cx0 + c.x * 1000, fy: cy0 - c.y * 1000, wx: c.x * 1000, wy: c.y * 1000 }));

// rows -> quads: row pairs (bottom, top), columns paired (W,E), W->E in every band
const rowKey = (c) => +c.wy.toFixed(3);
const rowsYs = [...new Set(coils.map(rowKey))].sort((a, b) => a - b);
const rowIdx = new Map(rowsYs.map((y, i2) => [y, i2]));
const byRow = new Map();
coils.forEach((c, i2) => {
  const r = rowIdx.get(rowKey(c));
  if (!byRow.has(r)) byRow.set(r, []);
  byRow.get(r).push({ i: i2, x: c.wx });
});
for (const r of byRow.keys()) byRow.get(r).sort((a, b) => a.x - b.x);
const quads = [];                                // {cells:[SW,SE,NW,NE], band, pos}
for (let band = 0; band * 2 + 1 < rowsYs.length; band++) {
  const lo = byRow.get(band * 2), hi = byRow.get(band * 2 + 1);
  for (let p2 = 0; p2 + 1 < lo.length; p2 += 2) {
    quads.push({ cells: [lo[p2].i, lo[p2 + 1].i, hi[p2].i, hi[p2 + 1].i], band, pos: p2 / 2 });
  }
}
const G = quads.length;
console.log(`quads: ${G} (${rowsYs.length / 2} bands)`);
// chain nets DATA_0..DATA_G
const newDecls = [];
const needNets = ['SDA', 'SCL'];
for (let k2 = 0; k2 <= G; k2++) needNets.push(`DATA_${k2}`);
for (const nm of needNets) {
  if (!netOf.has(nm)) { netOf.set(nm, nextNet); newDecls.push(`  (net ${nextNet} "${nm}")`); nextNet++; }
}
if (newDecls.length) {
  const lastDecl = [...txt.matchAll(/^  \(net \d+ "[^"]*"\)$/gm)].pop();
  txt = txt.slice(0, lastDecl.index + lastDecl[0].length) + '\n' + newDecls.join('\n')
    + txt.slice(lastDecl.index + lastDecl[0].length);
}

// quad origin: the SW cell's centre (world); other cells at fixed offsets
const qOff = [[0, 0], [pitch, 0], [-pitch / 2, rowH], [pitch / 2, rowH]];
{
  // verify against the real lattice once (offsets depend on stagger sign)
  const q0 = quads[Math.floor(G / 2)];
  const o = coils[q0.cells[0]];
  q0.cells.forEach((ci, k2) => {
    const dx = coils[ci].wx - o.wx, dy = coils[ci].wy - o.wy;
    if (Math.hypot(dx - qOff[k2][0], dy - qOff[k2][1]) > 0.01) {
      qOff[k2] = [dx, dy];
    }
  });
  console.log('quad offsets:', qOff.map((v) => v.map((x) => +x.toFixed(2)).join(',')).join('  '));
}

// --- seam vias (between every horizontally adjacent cell pair) --------------
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
    if (hexDist(dx, dy) < coilKeepR + CLR + rV) return 'coil';
  }
  for (const v of board.vias) {
    const d = Math.hypot(fx - v.x, fy - v.y);
    if (d < vSize + CLR && d > 1e-6) return 'via';
  }
  for (const fp of board.fps) for (const pd of fp.pads) {
    const a = (pd.ang * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const dx = fx - (fp.x + pd.dx), dy = fy - (fp.y + pd.dy);
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const qx = Math.max(Math.abs(lx) - pd.w / 2, 0), qy = Math.max(Math.abs(ly) - pd.h / 2, 0);
    if (Math.hypot(qx, qy) < CLR + rV) return `pad ${fp.ref}`;
  }
  if (fx - minX < 0.45 || maxX - fx < 0.45 || fy - minY < 0.45 || maxY - fy < 0.45) return 'edge';
  return null;
};
const eastOf = new Map();
for (const [i2, c] of coils.entries()) {
  const j = coils.findIndex((d) => Math.abs(d.wx - c.wx - pitch) < 0.01 && Math.abs(d.wy - c.wy) < 0.01);
  if (j >= 0) eastOf.set(i2, j);
}
// which chain net crosses the seam east of cell i (bottom-row quad boundary)?
const quadOfCell = new Map();
quads.forEach((q, g2) => q.cells.forEach((ci, k2) => quadOfCell.set(ci, { g: g2, k: k2 })));
const chainNetEastOf = (i2) => {
  const q = quadOfCell.get(i2);
  const j = eastOf.get(i2);
  if (q == null || j == null) return null;
  const qj = quadOfCell.get(j);
  // the DATA link uses the BOTTOM row seam between quad g and g+1 in a band
  if (q.k === 1 && qj?.k === 0 && qj.g === q.g + 1 && quads[q.g].band === quads[qj.g].band) return `DATA_${qj.g}`;
  return null;
};
const seamVias = [];
let seamBad = 0;
for (const [i2, j] of eastOf) {
  for (const s of SEAM_SIGNALS) {
    const fx = coils[i2].fx + s.at[0], fy = coils[i2].fy - s.at[1];
    const bad = seamOK(fx, fy);
    if (bad) { seamBad++; continue; }
    let name = s.net;
    if (s.net === 'DATA') {
      name = chainNetEastOf(i2);
      if (!name) continue;                       // no chain link on this seam
    }
    seamVias.push({ fx, fy, netNum: netOf.get(name), netName: name, cell: i2 });
  }
}
console.log(`seam vias: ${seamVias.length}, blocked ${seamBad}`);

// --- placement machinery (quad frame, y-up, SW cell centre origin) ----------
const qc = quads[Math.floor(G / 2)];
const qo = coils[qc.cells[0]];
console.log(`centre quad ${Math.floor(G / 2)}: cells ${qc.cells.join(',')}`);
const latt = [[2 * pitch, 0], [-2 * pitch, 0], [0, 2 * rowH], [0, -2 * rowH],
  [2 * pitch, 2 * rowH], [2 * pitch, -2 * rowH], [-2 * pitch, 2 * rowH], [-2 * pitch, -2 * rowH]];
const rot2 = (px, py, c, s) => [px * c - py * s, px * s + py * c];
const rcOverlap = (a, b, grow) => {
  const test = (p2, q, pg, qg) => {
    const ca = Math.cos(p2.ang), sa = Math.sin(p2.ang);
    const dx = q.cx - p2.cx, dy = q.cy - p2.cy;
    const qx = dx * ca + dy * sa, qy = -dx * sa + dy * ca;
    const rel = q.ang - p2.ang, cr = Math.abs(Math.cos(rel)), sr = Math.abs(Math.sin(rel));
    const qw = q.w / 2 + qg, qh = q.h / 2 + qg;
    return Math.abs(qx) <= p2.w / 2 + pg + cr * qw + sr * qh && Math.abs(qy) <= p2.h / 2 + pg + sr * qw + cr * qh;
  };
  return test(a, b, 0, grow) && test(b, a, grow, 0);
};
const circHit = (r2, cx2, cy2, rad) => {
  const c = Math.cos(r2.ang), s = Math.sin(r2.ang), dx = cx2 - r2.cx, dy = cy2 - r2.cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.max(Math.abs(lx) - r2.w / 2, 0), qy = Math.max(Math.abs(ly) - r2.h / 2, 0);
  return qx * qx + qy * qy <= rad * rad;
};
const discs = [];
for (const v of board.vias) {
  const dx = v.x - qo.fx, dy = -(v.y - qo.fy);
  if (Math.hypot(dx - pitch / 2, dy - rowH / 2) < pitch * 2.6) discs.push({ x: dx, y: dy, r: v.size / 2 });
}
for (const s2 of seamVias) {
  const dx = s2.fx - qo.fx, dy = -(s2.fy - qo.fy);
  if (Math.hypot(dx - pitch / 2, dy - rowH / 2) < pitch * 2.6) discs.push({ x: dx, y: dy, r: vSize / 2 });
}
const baseRects = [];
for (const fp of board.fps) {
  for (const pd of fp.pads) {
    const rx2 = fp.x + pd.dx - qo.fx, ry2 = -(fp.y + pd.dy - qo.fy);
    if (Math.hypot(rx2 - pitch / 2, ry2 - rowH / 2) > pitch * 2.6) continue;
    baseRects.push({ cx: rx2, cy: ry2, w: pd.w, h: pd.h, ang: (pd.ang * Math.PI) / 180 });
  }
}
const placedRects = [];
const partFits = (fp, rx, ry, ang, clr) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  const pads = fp.pads.map(([px, py, w, h]) => {
    const [qx, qy] = rot2(px, py, c, s);
    return { cx: rx + qx, cy: ry + qy, w, h, ang };
  });
  const bodyR = { cx: rx, cy: ry, w: fp.body[0], h: fp.body[1], ang };
  for (const pr of pads) {
    for (const d of discs) if (circHit(pr, d.x, d.y, d.r + clr)) return false;
    for (const [ox, oy] of [[0, 0], ...latt]) {
      for (const r2 of baseRects) if (rcOverlap(pr, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
      for (const r2 of placedRects) if (rcOverlap(pr, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
    }
  }
  for (const [ox, oy] of [[0, 0], ...latt]) {
    for (const r2 of placedRects) if (rcOverlap(bodyR, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
    for (const r2 of baseRects) if (rcOverlap(bodyR, { ...r2, cx: r2.cx + ox, cy: r2.cy + oy }, clr)) return false;
  }
  return true;
};
// Cell-level parts (U, C) repeat PER CELL: when testing them, also test their
// copies at the three sibling cell offsets (they will be stamped there too).
const cellCopies = qOff;
const partFitsAllCells = (fp, rx, ry, ang, clr) => {
  for (const [ox, oy] of cellCopies) if (!partFits(fp, rx + ox, ry + oy, ang, clr)) return false;
  return true;
};
const search = (fp, costFn, { rotStep = 30, span = [[-3.6, 3.6], [-4.8, 4.8]], perCell = false, override } = {}) => {
  const fits = perCell ? partFitsAllCells : partFits;
  if (override) {
    const [rx, ry, rdeg] = override.split(',').map(Number);
    for (const clr of [0.30, 0.25, 0.20, 0.15, 0.12, 0.09]) {
      if (fits(fp, rx, ry, (rdeg * Math.PI) / 180, clr)) {
        return { rx, ry, rdeg, clr, cost: costFn(rx, ry, (rdeg * Math.PI) / 180) };
      }
    }
    console.log(`override ${override} DOES NOT FIT`);
    return null;
  }
  let best = null;
  for (const clr of [0.30, 0.25, 0.20, 0.15, 0.12, 0.09]) {
    for (let rx = span[0][0]; rx <= span[0][1]; rx += 0.1) {
      for (let ry = span[1][0]; ry <= span[1][1]; ry += 0.1) {
        for (let rdeg = 0; rdeg < 360; rdeg += rotStep) {
          const ang = (rdeg * Math.PI) / 180;
          if (!fits(fp, rx, ry, ang, clr)) continue;
          const cost = costFn(rx, ry, ang);
          if (!best || cost < best.cost) best = { rx, ry, rdeg, clr, cost };
        }
      }
    }
    if (best) return best;
  }
  return null;
};
const commit = (fp, pl, offs = [[0, 0]]) => {
  const c = Math.cos((pl.rdeg * Math.PI) / 180), s = Math.sin((pl.rdeg * Math.PI) / 180);
  for (const [ox, oy] of offs) {
    for (const [px, py, w, h] of fp.pads) {
      const [qx, qy] = rot2(px, py, c, s);
      placedRects.push({ cx: pl.rx + ox + qx, cy: pl.ry + oy + qy, w, h, ang: (pl.rdeg * Math.PI) / 180 });
    }
    placedRects.push({ cx: pl.rx + ox, cy: pl.ry + oy, w: fp.body[0], h: fp.body[1], ang: (pl.rdeg * Math.PI) / 180 });
  }
};
const padAt = (fp, pl, idx) => {
  const c = Math.cos((pl.rdeg * Math.PI) / 180), s = Math.sin((pl.rdeg * Math.PI) / 180);
  const [qx, qy] = rot2(fp.pads[idx][0], fp.pads[idx][1], c, s);
  return [pl.rx + qx, pl.ry + qy];
};
const d2 = (p2, q) => Math.hypot(p2[0] - q[0], p2[1] - q[1]);
const anchorOf = Object.fromEntries(SEAM_SIGNALS.map((s) => [s.net, s.at]));

// --- 1. bridge + decap, one offset stamped in all four cells ---------------
const J_IN = [3.781, -1.955], J_OUT = [1.736, -3.363];
const fpU = FOOTPRINTS.sot23hb;
const plU = search(fpU, (rx, ry, ang) => {
  const pl = { rx, ry, rdeg: (ang * 180) / Math.PI };
  return d2(padAt(fpU, pl, 1), J_IN) + d2(padAt(fpU, pl, 5), J_OUT)
    + 0.6 * d2(padAt(fpU, pl, 3), anchorOf.VBUS) + 0.6 * d2(padAt(fpU, pl, 2), anchorOf.GND)
    + 0.4 * (d2(padAt(fpU, pl, 0), [pitch / 2, rowH / 2]) + d2(padAt(fpU, pl, 4), [pitch / 2, rowH / 2]));
}, { perCell: true, span: [[-3.4, 3.4], [-4.4, 4.4]], override: process.env.U_AT });
if (!plU) { console.log('NO bridge placement'); process.exit(1); }
commit(fpU, plU, cellCopies);
console.log(`bridge at (${plU.rx.toFixed(1)}, ${plU.ry.toFixed(1)}) rot ${plU.rdeg} clr ${plU.clr}`);
const fpC = { label: '0402 decap', body: [1.0, 0.5], pads: [[-0.5, 0, 0.5, 0.4], [0.5, 0, 0.5, 0.4]] };
const uVBUS = padAt(fpU, plU, 3), uGND = padAt(fpU, plU, 2);
const plC = search(fpC, (rx, ry, ang) => {
  const pl = { rx, ry, rdeg: (ang * 180) / Math.PI };
  return d2(padAt(fpC, pl, 0), uVBUS) + d2(padAt(fpC, pl, 1), uGND)
    + 0.3 * d2(padAt(fpC, pl, 0), anchorOf.VBUS) + 0.3 * d2(padAt(fpC, pl, 1), anchorOf.GND);
}, { rotStep: 90, perCell: true, span: [[-3.4, 3.4], [-4.4, 4.4]], override: process.env.C_AT });
if (!plC) { console.log('NO decap placement'); process.exit(1); }
commit(fpC, plC, cellCopies);
console.log(`decap at (${plC.rx.toFixed(1)}, ${plC.ry.toFixed(1)}) rot ${plC.rdeg} clr ${plC.clr}`);

// --- 2. register, one per quad ----------------------------------------------
// qfn16 pad indices (0-based): right col 1 q7s, 3 mr, 5 sclk, 7 rclk, 9 oen,
// 11 ds, 13 q0, 15 vcc; left col 0 gnd, 14 q1, 12 q2, 10 q3, 8 q4, 6 q5, 4 q6, 2 q7.
const fpS = FOOTPRINTS.qfn16;
// bridge PWM pads per cell (quad frame)
const pwmPads = cellCopies.map(([ox, oy]) => [
  [padAt(fpU, plU, 0)[0] + ox, padAt(fpU, plU, 0)[1] + oy],
  [padAt(fpU, plU, 4)[0] + ox, padAt(fpU, plU, 4)[1] + oy],
]);
const W_DATA = [anchorOf.DATA[0] - pitch, anchorOf.DATA[1]];             // SW cell's W seam
const E_DATA = [anchorOf.DATA[0] + pitch, anchorOf.DATA[1]];             // SE cell's E seam
const plS = search(fpS, (rx, ry, ang) => {
  const pl = { rx, ry, rdeg: (ang * 180) / Math.PI };
  // The WORST PWM run decides routability, not the sum: an east-biased spot
  // minimised total length and stranded the SW and NW cells' PWM entirely.
  let worst = 0, c = 0;
  for (const [pa, pb] of pwmPads) {
    const d = Math.max(d2(padAt(fpS, pl, 13), pa), d2(padAt(fpS, pl, 14), pb));
    worst = Math.max(worst, d);
    c += 0.1 * d;
  }
  return c + 1.5 * worst + 0.3 * (d2(padAt(fpS, pl, 11), W_DATA) + d2(padAt(fpS, pl, 1), E_DATA))
    + 0.3 * d2(padAt(fpS, pl, 0), [anchorOf.GND[0], anchorOf.GND[1]])
    + 0.3 * d2(padAt(fpS, pl, 15), [anchorOf.VLOGIC[0], anchorOf.VLOGIC[1]]);
}, { span: [[-2, 2 + pitch], [-3, 4]], override: process.env.SR_AT });
if (!plS) { console.log('NO register placement'); process.exit(1); }
commit(fpS, plS);
console.log(`register at (${plS.rx.toFixed(1)}, ${plS.ry.toFixed(1)}) rot ${plS.rdeg} clr ${plS.clr}`);

// --- emit --------------------------------------------------------------------
const f3 = (v) => +v.toFixed(4);
const leftFn = ['gnd', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'];
const rightFn = ['q7s', 'mr', 'sclk', 'rclk', 'oen', 'ds', 'q0', 'vcc'];
const emit = [];
const emitPartText = (lib, value, ref, lcsc, fp, pl, fx, fy, netForPad) => {
  const ang = (pl.rdeg * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
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
// Rim cells' terminal pads and vias RELOCATE (edge-aware viaPlan), so the
// uniform part offsets can land on them there. Verify each emission against
// the cell's ACTUAL board copper and nudge locally when it clashes -- rim
// stamps are trimmed at clone time anyway, so losing part-position identity
// on the rim costs nothing the rim had.
let nudged = 0;
const fitOrNudge = (fp, pl, fx0, fy0) => {
  const obs = { discs: [], rects: [] };
  for (const v of board.vias) {
    const dx = v.x - fx0, dy = -(v.y - fy0);
    if (Math.hypot(dx, dy) < pitch * 1.4) obs.discs.push({ x: dx, y: dy, r: v.size / 2 });
  }
  for (const fp2 of board.fps) for (const pd of fp2.pads) {
    const dx = fp2.x + pd.dx - fx0, dy = -(fp2.y + pd.dy - fy0);
    if (Math.hypot(dx, dy) < pitch * 1.4) obs.rects.push({ cx: dx, cy: dy, w: pd.w, h: pd.h, ang: (pd.ang * Math.PI) / 180 });
  }
  const ok = (rx, ry, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    for (const [px, py, w, h] of fp.pads) {
      const [qx, qy] = rot2(px, py, c, s);
      const pr = { cx: rx + qx, cy: ry + qy, w, h, ang };
      for (const d of obs.discs) if (circHit(pr, d.x, d.y, d.r + 0.09)) return false;
      for (const r2 of obs.rects) if (rcOverlap(pr, r2, 0.09)) return false;
    }
    return true;
  };
  const ang0 = (pl.rdeg * Math.PI) / 180;
  if (ok(0, 0, ang0)) return pl;                 // uniform spot is fine here
  for (let rad = 0.1; rad <= 1.6; rad += 0.1) {
    for (let a = 0; a < 12; a++) {
      const rx = rad * Math.cos((a * Math.PI) / 6), ry = rad * Math.sin((a * Math.PI) / 6);
      for (let dd = 0; dd < 360; dd += 30) {
        if (ok(rx, ry, ((pl.rdeg + dd) * Math.PI) / 180)) {
          nudged++;
          return { ...pl, rx: pl.rx + rx, ry: pl.ry + ry, rdeg: (pl.rdeg + dd) % 360 };
        }
      }
    }
  }
  console.log('fitOrNudge: no clear spot near uniform placement');
  return pl;
};
// PWM wiring convention: q0/q1 -> SW, q2/q3 -> SE, q4/q5 -> NW, q6/q7 -> NE
const qFn = [['q0', 'q1'], ['q2', 'q3'], ['q4', 'q5'], ['q6', 'q7']];
for (const [g2, q] of quads.entries()) {
  const o = coils[q.cells[0]];
  q.cells.forEach((ci, k2) => {
    const plU2 = fitOrNudge(fpU, plU, o.fx + qOff[k2][0] + plU.rx, o.fy - qOff[k2][1] - plU.ry);
    const fx = o.fx + qOff[k2][0] + plU2.rx, fy = o.fy - qOff[k2][1] - plU2.ry;
    emitPartText('SOT23HB', 'TC118S', `U${ci}`, 'C88308', fpU, plU2, fx, fy,
      (k3) => [`PWMA_${ci}`, `coil_${ci}`, 'GND', 'VBUS', `PWMB_${ci}`, `coil_${ci}`][k3]);
    const plC2 = fitOrNudge(fpC, plC, o.fx + qOff[k2][0] + plC.rx, o.fy - qOff[k2][1] - plC.ry);
    const cfx = o.fx + qOff[k2][0] + plC2.rx, cfy = o.fy - qOff[k2][1] - plC2.ry;
    emitPartText('C0402', '100n', `C${ci}`, 'C1525', fpC, plC2, cfx, cfy, (k3) => ['VBUS', 'GND'][k3]);
  });
  const plS2 = fitOrNudge(fpS, plS, o.fx + plS.rx, o.fy - plS.ry);
  const sfx = o.fx + plS2.rx, sfy = o.fy - plS2.ry;
  emitPartText('SR595Q', '74HC595BQ', `SR${g2}`, 'C730243', fpS, plS2, sfx, sfy, (k3) => {
    const fn = (k3 % 2 === 0 ? leftFn : rightFn)[k3 >> 1];
    if (fn === 'gnd') return 'GND';
    if (fn === 'vcc' || fn === 'mr') return 'VLOGIC';
    if (fn === 'sclk') return 'SCLK';
    if (fn === 'rclk') return 'RCLK';
    if (fn === 'oen') return 'OE_N';
    if (fn === 'ds') return `DATA_${g2}`;
    if (fn === 'q7s') return `DATA_${g2 + 1}`;
    for (let k4 = 0; k4 < 4; k4++) {
      if (fn === qFn[k4][0]) return `PWMA_${q.cells[k4]}`;
      if (fn === qFn[k4][1]) return `PWMB_${q.cells[k4]}`;
    }
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
writeFileSync(new URL(`./${outKey}.quads.json`, import.meta.url), JSON.stringify({
  quads, qOff, centreQuad: Math.floor(G / 2), plU, plC, plS, nudged,
  viaPlanOpts: VIA_PLAN_OPTS,                    // so quadroute's stub plan matches the board
}, null, 1));
console.log(`wrote ${outKey}.kicad_pcb + ${outKey}.quads.json`);
