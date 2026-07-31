// Scan candidate REGISTER placements (position x rotation) for the SR
// re-rotation co-design (single-cell-periodic-routing: the committed spot's
// pocket is saturated -- all 9 remaining stamp misses are register escapes).
// This is the cheap geometric PRE-FILTER in front of the pipeline sweep: the
// pipeline (quadgen SR_AT= -> lanegen SR_SWEEP=1 -> quadroute stages) is the
// oracle; this script only decides which ~dozen candidates get pipeline time.
//
// For each candidate that FITS (quadgen's clearance tiers, incl. lattice
// copies) and CLEARS the constructed comb/lane copper (lanegen's verifier
// would exit 1 otherwise), score = sum over the 16 real pad jobs (8 PWMs to
// their U pads, 8 control drops to the taps the SR_SWEEP proximity rule
// would pick) of straight-line length plus heavily-weighted obstructed
// length. Straight-line obstruction is a proxy -- freerouting and the A*
// both bend -- but a pad whose whole bearing to its destination is walled
// scores exactly like the measured east-pocket saturation this is meant to
// escape, and the candidate's own other pads are obstacles too, so the
// fan-crossing problem (the root geometric mismatch) is priced in.
//
//   node srscan.mjs [board] [constructed.ses]
// Writes <board base>.srscan.json (ranked, diversity-picked shortlist).
import { readFileSync, writeFileSync } from 'fs';
import { FOOTPRINTS } from '../src/kicad.js';
import { makeStator } from '../src/coils.js';
import { readBoard } from './mkdsn.mjs';
import { SEAM_SIGNALS } from './cellspec.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));

const boardPath = process.argv[2] || 'qlane.kicad_pcb';
const sesPath = process.argv[3] || 'qlane.lanes.ses';
const spec = JSON.parse(readFileSync(boardPath.replace(/\.kicad_pcb$/, '.quads.json'), 'utf8'));
const { quads, centreQuad } = spec;
const Q = quads[centreQuad];

const board = readBoard(boardPath);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const pitch = cfg.stator.coilPitch * 1000;
const rowH = pitch * Math.sqrt(3) / 2;
const coils = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);
const [c78x, c78y] = coils[Q.cells[0]];
const off = Object.fromEntries(SEAM_SIGNALS.map((s) => [s.net, s.at]));
const at = (net) => [c78x + off[net][0], c78y - off[net][1]];
const west = (net) => [at(net)[0] - pitch, at(net)[1]];

// --- obstacle set (board frame, y-down) --------------------------------------
// discs: every via (incl. the whole seam ladder). rects: every pad EXCEPT the
// registers' (they all move together), plus a body rect per part (quadgen's
// fit checks bodies; the board file only has pads).
const BODIES = { SOT23HB: [2.9, 1.6], C0402: [1.0, 0.5] };
const discs = [], rects = [];
for (const v of board.vias) discs.push({ x: v.x, y: v.y, r: v.size / 2 });
for (const fp of board.fps) {
  if (/^SR\d+$/.test(fp.ref)) continue;
  for (const pd of fp.pads) {
    rects.push({ x: fp.x + pd.dx, y: fp.y + pd.dy, w: pd.w, h: pd.h, rot: -((fp.rot || 0) + (pd.ang || 0)), ref: fp.ref, pad: pd.name });
  }
  const bd = BODIES[fp.lib];
  if (bd) rects.push({ x: fp.x, y: fp.y, w: bd[0], h: bd[1], rot: -(fp.rot || 0), ref: fp.ref, pad: 'body' });
}
// constructed copper: B.Cu net blocks from the SR_SWEEP control .ses, minus
// coil_78_B (its path re-adapts to every candidate). In12 runs are invisible
// to the register's B.Cu world; the DATA_E portal via is a real barrel.
const segs = [], cviaDiscs = [];
{
  const ses = readFileSync(sesPath, 'utf8');
  const res = ses.match(/\(resolution (\w+) (\d+)\)/);
  const scale = ((res ? res[1] : 'um') === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
  const routes = ses.slice(ses.indexOf('(network_out'));
  for (const nm of routes.matchAll(/\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g)) {
    const skip = nm[1] === `coil_${Q.cells[0]}_B`;
    for (const w of nm[2].matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
      if (skip || w[1] !== 'B.Cu') continue;
      const nums = w[3].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 3 < nums.length; i += 2) {
        segs.push({ a: [nums[i] * scale, -nums[i + 1] * scale], b: [nums[i + 2] * scale, -nums[i + 3] * scale], hw: (+w[2] * scale) / 2 });
      }
    }
    for (const v of nm[2].matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
      if (skip) continue;
      const [x, y] = v[1].trim().split(/\s+/).map(Number);
      cviaDiscs.push({ x: x * scale, y: -y * scale, r: 0.25 });
    }
  }
  for (const d of cviaDiscs) discs.push(d);
}
console.log(`obstacles: ${discs.length} discs, ${rects.length} rects, ${segs.length} constructed B.Cu segs`);

// spatial hash so 70k candidates stay cheap
const CELL = 2.0;
const bucket = new Map();
const bkey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
const bput = (x, y, r, item) => {
  for (let bx = Math.floor((x - r) / CELL); bx <= Math.floor((x + r) / CELL); bx++) {
    for (let by = Math.floor((y - r) / CELL); by <= Math.floor((y + r) / CELL); by++) {
      const k = `${bx},${by}`;
      if (!bucket.has(k)) bucket.set(k, { discs: [], rects: [], segs: [] });
      bucket.get(k)[item.kind].push(item.v);
    }
  }
};
for (const d of discs) bput(d.x, d.y, d.r + 0.6, { kind: 'discs', v: d });
for (const r of rects) bput(r.x, r.y, Math.hypot(r.w, r.h) / 2 + 0.6, { kind: 'rects', v: r });
for (const s of segs) {
  const cx = (s.a[0] + s.b[0]) / 2, cy = (s.a[1] + s.b[1]) / 2;
  bput(cx, cy, Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) / 2 + s.hw + 0.6, { kind: 'segs', v: s });
}
const near = (x, y) => bucket.get(bkey(x, y)) || { discs: [], rects: [], segs: [] };

const inRect = (x, y, g, inflate) => {
  const a = (g.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const dx = x - g.x, dy = y - g.y;
  const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
  return Math.abs(lx) <= g.w / 2 + inflate && Math.abs(ly) <= g.h / 2 + inflate;
};
const ptSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
// distance from a segment to a rotated rect, sampled on the rect boundary --
// same conservative approach as lanegen's verifier
const rectBoundary = (g) => {
  const a = (g.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = -0.5 + i / 8;
    for (const [lx, ly] of [[t * g.w, -g.h / 2], [t * g.w, g.h / 2], [-g.w / 2, t * g.h], [g.w / 2, t * g.h]]) {
      pts.push([g.x + lx * ca - ly * sa, g.y + lx * sa + ly * ca]);
    }
  }
  return pts;
};
const segRectDist = (seg, g) => {
  let d = Math.min(
    inRect(seg.a[0], seg.a[1], g, 0) ? 0 : 1e9,
    inRect(seg.b[0], seg.b[1], g, 0) ? 0 : 1e9,
  );
  for (const [x, y] of rectBoundary(g)) d = Math.min(d, ptSeg(x, y, seg.a[0], seg.a[1], seg.b[0], seg.b[1]));
  return d;
};

// --- candidate geometry -------------------------------------------------------
const fpS = FOOTPRINTS.qfn16;
const rot2 = (px, py, c, s) => [px * c - py * s, px * s + py * c];
// candidate pad centres+rects in board frame; quadgen: board = (c78x + rx + qx,
// c78y - ry - qy) with [qx,qy] = rot2(pad, rdeg) in the y-up quad frame
const candPads = (rx, ry, rdeg) => {
  const c = Math.cos((rdeg * Math.PI) / 180), s = Math.sin((rdeg * Math.PI) / 180);
  return fpS.pads.map(([px, py, w, h], i) => {
    const [qx, qy] = rot2(px, py, c, s);
    return { name: `${i + 1}`, x: c78x + rx + qx, y: c78y - ry - qy, w, h, rot: -rdeg };
  });
};
const candBody = (rx, ry, rdeg) => ({ x: c78x + rx, y: c78y - ry, w: fpS.body[0], h: fpS.body[1], rot: -rdeg });
const latt = [[0, 0], [2 * pitch, 0], [-2 * pitch, 0], [0, 2 * rowH], [0, -2 * rowH],
  [2 * pitch, 2 * rowH], [2 * pitch, -2 * rowH], [-2 * pitch, 2 * rowH], [-2 * pitch, -2 * rowH]];

const rectsClash = (g, h, grow) => {
  // OBB overlap via corner-sampling both ways (cheap, conservative enough at
  // scan scale; quadgen's SAT is the authority and re-checks the winner)
  for (const [x, y] of rectBoundary({ ...g, w: g.w + 2 * grow, h: g.h + 2 * grow })) if (inRect(x, y, h, 0)) return true;
  for (const [x, y] of rectBoundary({ ...h, w: h.w + 2 * grow, h: h.h + 2 * grow })) if (inRect(x, y, g, 0)) return true;
  return false;
};
const discRect = (d, g, grow) => {
  if (inRect(d.x, d.y, g, d.r + grow)) return true;
  return false;
};
const fitClr = (rx, ry, rdeg) => {
  for (const clr of [0.30, 0.25, 0.20, 0.15, 0.12, 0.09]) {
    let ok = true;
    outer: for (const [ox, oy] of latt) {
      const pads = candPads(rx + ox, ry + oy, rdeg);
      const bodyR = candBody(rx + ox, ry + oy, rdeg);
      for (const p of pads) {
        const nb = near(p.x, p.y);
        for (const d of nb.discs) if (discRect(d, p, clr)) { ok = false; break outer; }
        for (const r of nb.rects) if (rectsClash(p, r, clr)) { ok = false; break outer; }
      }
      const nb = near(bodyR.x, bodyR.y);
      for (const r of nb.rects) if (rectsClash(bodyR, r, clr)) { ok = false; break outer; }
    }
    if (ok) return clr;
  }
  return 0;
};
// lanegen's verifier holds constructed B.Cu centrelines at CLR + W/2 = half
// width + 0.09 from pad edges; require 0.02 more so the sweep does not die
// at the verifier over sampling error
const combClear = (rx, ry, rdeg) => {
  for (const p of candPads(rx, ry, rdeg)) {
    for (const s of near(p.x, p.y).segs) {
      if (segRectDist(s, p) < s.hw + 0.11) return false;
    }
  }
  return true;
};

// --- the 16 jobs --------------------------------------------------------------
// pad index (1-based, quadgen's array order) -> destination
const uPad = (ci, name) => {
  const fp = board.fps.find((f) => f.ref === `U${ci}`);
  const p = fp.pads.find((q) => q.name === name);
  return [fp.x + p.dx, fp.y + p.dy];
};
const PWM_JOBS = [
  ['3', uPad(Q.cells[3], '5')], ['5', uPad(Q.cells[3], '1')],   // q7/q6 -> NE
  ['7', uPad(Q.cells[2], '5')], ['9', uPad(Q.cells[2], '1')],   // q5/q4 -> NW
  ['11', uPad(Q.cells[1], '5')], ['13', uPad(Q.cells[1], '1')], // q3/q2 -> SE
  ['15', uPad(Q.cells[0], '5')], ['14', uPad(Q.cells[0], '1')], // q1/q0 -> SW
];
const nearer = (net, px, py) => {
  const e = at(net), w = west(net);
  return Math.hypot(e[0] - px, e[1] - py) <= Math.hypot(w[0] - px, w[1] - py) ? [e, w] : [w, e];
};
const jobsFor = (pads) => {
  const P = Object.fromEntries(pads.map((p) => [p.name, p]));
  const jobs = [];
  for (const [nm, dest] of PWM_JOBS) jobs.push({ pad: nm, net: `PWM@${nm}`, dest });
  for (const [net, nm] of [['SCLK', '6'], ['RCLK', '8'], ['OE_N', '10']]) {
    jobs.push({ pad: nm, net, dest: nearer(net, P[nm].x, P[nm].y)[0] });
  }
  const [v4, vOther] = nearer('VLOGIC', P['4'].x, P['4'].y);
  jobs.push({ pad: '4', net: 'VLOGIC_C', dest: v4 });
  jobs.push({ pad: '16', net: 'VLOGIC_CE', dest: vOther });
  jobs.push({ pad: '12', net: 'DATA_W', dest: west('DATA') });
  jobs.push({ pad: '2', net: 'DATA_E', dest: at('DATA') });
  jobs.push({ pad: '1', net: 'GND', dest: nearer('GND', P['1'].x, P['1'].y)[0] });
  return jobs;
};
const STEP = 0.05, ENDS = 0.35, INFL = 0.14;
const scoreJobs = (rx, ry, rdeg, detail) => {
  const pads = candPads(rx, ry, rdeg);
  let total = 0;
  for (const job of jobsFor(pads)) {
    const p = pads.find((q) => q.name === job.pad);
    const [ex, ey] = job.dest;
    const L = Math.hypot(ex - p.x, ey - p.y);
    let obs = 0;
    for (let t = ENDS; t <= L - ENDS; t += STEP) {
      const x = p.x + ((ex - p.x) * t) / L, y = p.y + ((ey - p.y) * t) / L;
      const nb = near(x, y);
      let hit = false;
      for (const d of nb.discs) if (Math.hypot(x - d.x, y - d.y) < d.r + INFL) { hit = true; break; }
      if (!hit) for (const r of nb.rects) if (inRect(x, y, r, INFL)) { hit = true; break; }
      if (!hit) for (const s of nb.segs) if (ptSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]) < s.hw + INFL) { hit = true; break; }
      if (!hit) for (const o of pads) if (o !== p && inRect(x, y, o, INFL)) { hit = true; break; }
      if (hit) obs += STEP;
    }
    const sc = 0.25 * L + 5 * obs;
    total += sc;
    if (detail) detail.push({ net: job.net, pad: job.pad, len: +L.toFixed(2), obs: +obs.toFixed(2), score: +sc.toFixed(2) });
  }
  return total;
};

// --- scan ---------------------------------------------------------------------
const cands = [];
const t0 = Date.now();
let fitN = 0, combN = 0;
const seen = new Set();
const tryCand = (rx, ry, rdeg) => {
  const key = `${rx.toFixed(2)},${ry.toFixed(2)},${rdeg.toFixed(0)}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const clr = fitClr(rx, ry, rdeg);
  if (!clr) return null;
  fitN++;
  if (!combClear(rx, ry, rdeg)) return null;
  combN++;
  const score = scoreJobs(rx, ry, rdeg) + (0.30 - clr) * 5;
  const c = { rx: +rx.toFixed(2), ry: +ry.toFixed(2), rdeg: +rdeg.toFixed(0), clr, score: +score.toFixed(2) };
  cands.push(c);
  return c;
};
const coarse = [];
for (let rx = -5.5; rx <= 12 + 1e-9; rx += 0.1) {
  for (let ry = -5; ry <= 5.2 + 1e-9; ry += 0.1) {
    for (let rdeg = 0; rdeg < 360; rdeg += 15) {
      if (tryCand(rx, ry, rdeg)) coarse.push([rx, ry, rdeg]);
    }
  }
}
// the fit islands are far smaller than the grid (28 hits in 300k points):
// refine each survivor's neighbourhood at 0.05 mm / 5 degrees -- better
// rotations and better clearance tiers hide between coarse points
for (const [rx0, ry0, r0] of coarse) {
  for (let dx = -0.15; dx <= 0.15 + 1e-9; dx += 0.05) {
    for (let dy = -0.15; dy <= 0.15 + 1e-9; dy += 0.05) {
      for (let dr = -10; dr <= 10; dr += 5) {
        tryCand(rx0 + dx, ry0 + dy, (r0 + dr + 360) % 360);
      }
    }
  }
}
// the committed spot, exactly, as the control
{
  const [rx, ry, rdeg] = [-0.707, -1.204, 330];
  const clr = fitClr(rx, ry, rdeg);
  const score = clr ? scoreJobs(rx, ry, rdeg) + (0.30 - clr) * 5 : 1e9;
  cands.push({ rx, ry, rdeeg: undefined, rdeg, clr, score: +score.toFixed(2), control: true });
}
cands.sort((a, b) => a.score - b.score);
console.log(`scan: ${fitN} fit, ${combN} clear the constructed copper (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// shortlist: the landscape is a few (pocket x orientation) classes -- per
// class keep the best score AND the best fat-clearance variant (clr 0.12
// gives the router real slack around the pads), control always included
const CAP = +(process.env.CANDS || 14);
const classOf = (c) => `${c.rx < 4 ? 'SW' : 'SE'}|${(Math.round(c.rdeg / 30) * 30) % 360}`;
const byClass = new Map();
for (const c of cands) {
  if (c.control) continue;
  const k = classOf(c);
  if (!byClass.has(k)) byClass.set(k, []);
  byClass.get(k).push(c);
}
const picked = [];
for (const [, list] of byClass) {
  list.sort((a, b) => a.score - b.score);
  picked.push(list[0]);
  const fat = list.find((c) => c.clr >= 0.12 && c !== list[0]);
  if (fat) picked.push(fat);
}
picked.sort((a, b) => a.score - b.score);
picked.splice(CAP);
const control = cands.find((c) => c.control);
picked.push(control);
for (const c of picked) {
  const detail = [];
  scoreJobs(c.rx, c.ry, c.rdeg, detail);
  c.jobs = detail;
}
writeFileSync(boardPath.replace(/\.kicad_pcb$/, '.srscan.json'), JSON.stringify({ picked, top50: cands.slice(0, 50) }, null, 1));
console.log(`\n rank  rx      ry      rot  clr   score  worst jobs`);
for (const [i, c] of picked.entries()) {
  const worst = [...c.jobs].sort((a, b) => b.score - a.score).slice(0, 3)
    .map((j) => `${j.net}:${j.obs}`).join(' ');
  console.log(`${String(i).padStart(4)}  ${String(c.rx).padStart(6)}  ${String(c.ry).padStart(6)}  ${String(c.rdeg).padStart(3)}  ${c.clr}  ${String(c.score).padStart(7)}  ${worst}${c.control ? '  <- committed spot' : ''}`);
}
console.log(`wrote ${boardPath.replace(/\.kicad_pcb$/, '.srscan.json')}`);
