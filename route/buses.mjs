// Construct the global bus copper instead of asking a router to find it.
//
// The measured facts behind this step (README "Known remaining"): the six big
// trees -- GND, VBUS, VLOGIC, SCLK, RCLK, OE_N -- are 998 of the board's 2563
// electronics pads, they are periodic over the honeycomb, and freerouting
// cannot route them even ALONE on an empty board (17 of 64 tile connections
// unrouted with nothing else present). The gutter lattice holds ~57 legal via
// sites per cell and the router places ~3, because finding a 0.9 mm slot with
// a maze search is hard and placing one deterministically is not.
//
// So the trees are laid the way the winding's own vias are laid: by
// construction, on the inner electronics layer, where only via LANDS are
// obstacles (traces cross the winding freely; only drills are confined to the
// gutter).
//
// The geometry that decides everything is the per-cell via pattern. Each cell
// puts 7 lands in its gutters and 6 in its centre hole, and they repeat with
// the lattice -- the clear straight windows left over are only 0.6-0.9 mm and
// sit at different heights row to row, so neither a straight lane nor a
// multi-lane bundle survives (a bundle's MIDDLE lane can never take a drop:
// its via land needs a ~1.9 mm corridor where 0.9 exists). What does work:
//
//   * TWO COMBS. GND owns the strip NORTH of every row's centre-hole ring,
//     VBUS the strip SOUTH of it -- teeth in disjoint y-strata can never
//     cross. Each net's teeth join a SPINE snaking down its own board margin
//     (GND left, VBUS right); the other net's teeth stop short of it. Every
//     tooth is a single-lane x-monotone path found by dynamic programming
//     through the land field; the spine is the same search rotated 90 deg.
//   * DROPS: a cell's pads for one net are clustered (bridge pin + decap, a
//     register's VCC + /MR, a sensor's supply), tied on B.Cu, and connected by
//     one via placed exactly where the net's tooth crosses a legal gutter slot
//     -- the same test viasites.mjs counts sites with.
//   * Junctions (spine-tooth, via-on-tooth) are explicit shared vertices:
//     crossing copper is connected to KiCad but a same-net violation to
//     freerouting, and a violation on protected wiring stalls its autorouter.
//   * VLOGIC and SCLK/RCLK/OE_N (registers + header) are NOT laid here yet;
//     they stay with the router. See the chain-bundle note at the bottom.
//
// Everything is best-effort: a strip that will not fit, a cluster that cannot
// reach a lane, a stub that will not lay -- each is reported and left for
// freerouting, which sees the constructed copper via CARRY and finishes the
// stragglers.
//
// `node buses.mjs <preset> <in.kicad_pcb> <out.kicad_pcb> [--tile=n]`
// Env: SPARE/LAYERS/FILL as in route.mjs; BUSNETS to override the net list.

import { readFileSync, writeFileSync } from 'fs';
import { makeStator } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize, viaDrill, FAB } from '../src/kicad.js';
import { readBoard } from './mkdsn.mjs';
import { makeField, prewire } from './prewire.mjs';

const f = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));

// --- board + geometry, exactly the way route.mjs derives them ---------------
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

const key = process.argv[2] || 'amzhex';
const inPath = process.argv[3] || `${key}.kicad_pcb`;
const outPath = process.argv[4] || inPath.replace(/\.kicad_pcb$/, '.bus.kicad_pcb');
const tileArg = process.argv.find((a) => a.startsWith('--tile='));
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));
if (cfg.stator.pcbSpareLayers == null) cfg.stator.pcbSpareLayers = 0;
if (process.env.SPARE) cfg.stator.pcbSpareLayers = +process.env.SPARE;
if (process.env.LAYERS) cfg.stator.pcbLayers = +process.env.LAYERS;
if (process.env.FILL) cfg.stator.coilFill = +process.env.FILL;
if (tileArg) cfg.stator.statorSize = (+tileArg.split('=')[1]) * cfg.stator.coilPitch;

const g = pcbCoilGeometry(cfg);
const pitch = cfg.stator.coilPitch * 1000;
const cellHalf = pitch / 2;
const vDia = viaSize(g, cellHalf);
const vDrill = viaDrill(vDia, g.thickness);
const vR = vDia / 2;
const CLR = FAB.minClearance;                    // 0.09
const N = cfg.stator.pcbLayers, spare = cfg.stator.pcbSpareLayers;
const cuName = (j) => (j === 0 ? 'F.Cu' : j === N - 1 ? 'B.Cu' : `In${j}.Cu`);
const PAD_LAYER = cuName(N - 1);                 // B.Cu
const TRUNK_LAYER = cuName(N - spare);           // the inner electronics layer

const board = readBoard(inPath);
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const coils = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);
const coilKeepR = g.halfOut + g.trace / 2;

// Outline as a closed loop for containment tests.
function outlineLoop(segs) {
  const keyOf = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
  const next = new Map();
  for (const [x0, y0, x1, y1] of segs) next.set(keyOf(x0, y0), [x1, y1]);
  const start = [segs[0][0], segs[0][1]];
  const loop = [start];
  let cur = start;
  for (let i = 0; i < segs.length; i++) {
    const n = next.get(keyOf(cur[0], cur[1]));
    if (!n) break;
    if (Math.abs(n[0] - start[0]) < 1e-6 && Math.abs(n[1] - start[1]) < 1e-6) break;
    loop.push(n); cur = n;
  }
  return loop;
}
const loop = outlineLoop(board.outline);
const inPoly = (x, y) => {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};
const ptSeg = (x, y, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const L = vx * vx + vy * vy;
  let t = L > 1e-12 ? ((x - ax) * vx + (y - ay) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
};
const distToOutline = (x, y) => {
  let d = Infinity;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    d = Math.min(d, ptSeg(x, y, loop[j][0], loop[j][1], loop[i][0], loop[i][1]));
  }
  return d;
};

// The winding tabs (crossover + terminal stubs), stamped per cell -- a via
// drilled into one shorts the coil. Same construction route.mjs uses.
const plan = viaPlan(g, g.layers, cellHalf, vDia);
const localStubs = [];
{
  const seen = new Set();
  for (const [x0, y0, x1, y1] of [...plan.segments, ...plan.terminals]) {
    const k = `${x0.toFixed(4)},${y0.toFixed(4)},${x1.toFixed(4)},${y1.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    localStubs.push([x0, y0, x1, y1]);
  }
}
const inHex = (x, y, R) => {
  let m = -Infinity;
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    m = Math.max(m, x * Math.cos(a) + y * Math.sin(a));
  }
  return m <= R;
};

// --- the nets and their lane widths -----------------------------------------
const BUS = (process.env.BUSNETS || 'GND,VBUS').split(',');
const netNum = new Map();                        // name -> board net number
for (const [num, name] of board.nets) netNum.set(name, num);
for (const n of BUS) if (!netNum.has(n)) { console.error(`net ${n} not on board`); process.exit(1); }

// --- via-site legality (the viasites.mjs test, as a function) ---------------
const allVias = board.vias.map((v) => ({ x: v.x, y: v.y, r: v.size / 2 }));
const allPads = [];
for (const fp of board.fps) {
  for (const pd of fp.pads) {
    // angle negated: pad angles are CCW in the y-UP sense, this is y-down
    allPads.push({
      x: fp.x + pd.dx, y: fp.y + pd.dy, w: pd.w, h: pd.h,
      ang: -((fp.rot + pd.ang) * Math.PI) / 180,
      r: Math.hypot(pd.w, pd.h) / 2, net: pd.netName,
    });
  }
}
// True distance from a point to a rotated pad rectangle -- the bounding circle
// of an elongated terminal pad blocks exactly the gutter slots a drop needs.
function padDist(x, y, p) {
  const c = Math.cos(-p.ang), s = Math.sin(-p.ang);
  const dx = x - p.x, dy = y - p.y;
  const lx = Math.abs(dx * c - dy * s), ly = Math.abs(dx * s + dy * c);
  const ox = Math.max(0, lx - p.w / 2), oy = Math.max(0, ly - p.h / 2);
  return Math.hypot(ox, oy);
}
const newVias = [];                              // constructed drop vias
const whyNot = { outline: 0, hex: 0, stub: 0, via: 0, newvia: 0, pad: 0, pinch: 0, prewire: 0 };
function viaLegal(x, y, net) {
  if (!inPoly(x, y) || distToOutline(x, y) < FAB.edgeClearance + vR) { whyNot.outline++; return false; }
  for (const [cxm, cym] of coils) {
    if (Math.hypot(x - cxm, y - cym) > cellHalf * 2) continue;
    if (inHex(x - cxm, y - cym, coilKeepR + CLR + vR)) { whyNot.hex++; return false; }
    for (const [sx0, sy0, sx1, sy1] of localStubs) {
      if (ptSeg(x, y, cxm + sx0, cym - sy0, cxm + sx1, cym - sy1) < g.trace / 2 + CLR + vR) { whyNot.stub++; return false; }
    }
  }
  for (const v of allVias) if (Math.hypot(x - v.x, y - v.y) < v.r + CLR + vR) { whyNot.via++; return false; }
  for (const v of newVias) if (Math.hypot(x - v.x, y - v.y) < vDia + CLR) { whyNot.newvia++; return false; }
  for (const p of allPads) {
    if (p.net === net) continue;
    if (Math.hypot(x - p.x, y - p.y) < p.r + CLR + vR && padDist(x, y, p) < CLR + vR) { whyNot.pad++; return false; }
  }
  // copper this run has already laid (stubs on B.Cu, trunks on the inner
  // layer) -- a via land is on every layer, so it must clear both
  for (const t of viaLegal.traces || []) {
    if (t.net === net) continue;
    for (let i = 0; i + 1 < t.pts.length; i++) {
      if (ptSeg(x, y, t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]) < t.width / 2 + CLR + vR) {
        whyNot.trace = (whyNot.trace || 0) + 1;
        return false;
      }
    }
  }
  return true;
}

// --- the two combs -----------------------------------------------------------
// Rows of the honeycomb, by ranked distinct y (board frame, y-down).
const yKey = (c) => +c[1].toFixed(3);
const rowYs = [...new Set(coils.map(yKey))].sort((a, b) => a - b);

// Topology: two interdigitated COMBS, one per net. GND owns the strip NORTH
// of every row's centre-hole ring, VBUS the strip SOUTH of it -- the teeth
// live in disjoint y-strata, so they can never cross each other. Each net's
// teeth are joined by a SPINE snaking down its own board margin (GND left,
// VBUS right); the other net's teeth stop short of that margin. Crossing a
// tooth of the SAME net is a T-junction, which is the point.
//
// A tooth is not a straight line -- the per-cell land pattern leaves clear
// windows of only 0.6-0.9 mm and they differ row to row -- so each tooth is
// an x-monotone path found by dynamic programming over a grid, dodging every
// land by the width a drop-via land needs. The spine is the same search
// rotated 90 degrees.
const LANE = 0.15;                               // trunk copper width
const CORR = vR + CLR + LANE / 2 + 0.075;        // centreline to nearest land
const XSTEP = 0.25, YSTEP = 0.1, MAXDY = 4;

const strat = (net, rowY) => (net === 'GND'
  ? [rowY - 2.9, rowY - 0.8]
  : [rowY + 0.8, rowY + 2.9]);

/** x-monotone path through [ylo,yhi] x board width, clear of lands. */
function toothPath(ylo, yhi) {
  const ys = [];
  for (let y = ylo; y <= yhi + 1e-9; y += YSTEP) ys.push(y);
  const xs = [];
  for (let x = minX + 0.6; x <= maxX - 0.6 + 1e-9; x += XSTEP) xs.push(x);
  const lands = allVias.filter((v) => v.y > ylo - 1 && v.y < yhi + 1);
  const ok = (xi, yj) => {
    const x = xs[xi], y = ys[yj];
    if (!inPoly(x, y) || distToOutline(x, y) < FAB.edgeClearance + LANE / 2 + 0.15) return false;
    for (const v of lands) {
      if (Math.abs(v.x - x) < XSTEP / 2 + v.r + CLR + 0.05
        && v.y > y - CORR - v.r && v.y < y + CORR + v.r) return false;
    }
    return true;
  };
  const feasible = xs.map((_, xi) => ys.some((_, yj) => ok(xi, yj)));
  let bestRun = null, runStart = null;
  for (let xi = 0; xi <= xs.length; xi++) {
    if (xi < xs.length && feasible[xi]) { if (runStart == null) runStart = xi; continue; }
    if (runStart != null) {
      if (!bestRun || xi - runStart > bestRun[1] - bestRun[0]) bestRun = [runStart, xi];
      runStart = null;
    }
  }
  if (!bestRun || bestRun[1] - bestRun[0] < 8) return null;
  const [xa, xb] = bestRun;
  const INF = 1e18;
  let cost = ys.map((_, j) => (ok(xa, j) ? 0 : INF));
  const from = xs.map(() => new Int16Array(ys.length).fill(-1));
  for (let xi = xa + 1; xi < xb; xi++) {
    const next = ys.map(() => INF);
    for (let yj = 0; yj < ys.length; yj++) {
      if (!ok(xi, yj)) continue;
      for (let d = -MAXDY; d <= MAXDY; d++) {
        const pj = yj + d;
        if (pj < 0 || pj >= ys.length || cost[pj] >= INF) continue;
        const c = cost[pj] + d * d + 0.01;
        if (c < next[yj]) { next[yj] = c; from[xi][yj] = pj; }
      }
    }
    cost = next;
  }
  let end = -1, best = INF;
  for (let j = 0; j < ys.length; j++) if (cost[j] < best) { best = cost[j]; end = j; }
  if (end < 0) return null;
  const path = [];
  let j = end;
  for (let xi = xb - 1; xi >= xa; xi--) {
    path.push([xs[xi], ys[j]]);
    j = from[xi][j] >= 0 ? from[xi][j] : j;
  }
  path.reverse();
  return path;
}

/** y-monotone spine through [xlo,xhi] x the board height. */
function spinePath(xlo, xhi, ylo, yhi) {
  const xs = [];
  for (let x = xlo; x <= xhi + 1e-9; x += YSTEP) xs.push(x);
  const ys = [];
  for (let y = ylo; y <= yhi + 1e-9; y += XSTEP) ys.push(y);
  const lands = allVias.filter((v) => v.x > xlo - 1 && v.x < xhi + 1);
  const ok = (yi, xj) => {
    const y = ys[yi], x = xs[xj];
    if (!inPoly(x, y) || distToOutline(x, y) < FAB.edgeClearance + LANE / 2 + 0.15) return false;
    for (const v of lands) {
      if (Math.abs(v.y - y) < XSTEP / 2 + v.r + CLR + 0.05
        && v.x > x - CORR - v.r && v.x < x + CORR + v.r) return false;
    }
    return true;
  };
  const INF = 1e18;
  let cost = xs.map((_, j) => (ok(0, j) ? 0 : INF));
  const from = ys.map(() => new Int16Array(xs.length).fill(-1));
  for (let yi = 1; yi < ys.length; yi++) {
    const next = xs.map(() => INF);
    for (let xj = 0; xj < xs.length; xj++) {
      if (!ok(yi, xj)) continue;
      for (let d = -MAXDY; d <= MAXDY; d++) {
        const pj = xj + d;
        if (pj < 0 || pj >= xs.length || cost[pj] >= INF) continue;
        const c = cost[pj] + d * d + 0.01;
        if (c < next[xj]) { next[xj] = c; from[yi][xj] = pj; }
      }
    }
    cost = next;
  }
  let end = -1, best = INF;
  for (let j = 0; j < xs.length; j++) if (cost[j] < best) { best = cost[j]; end = j; }
  if (end < 0) return null;
  const path = [];
  let j = end;
  for (let yi = ys.length - 1; yi >= 0; yi--) {
    path.push([xs[j], ys[yi]]);
    j = from[yi][j] >= 0 ? from[yi][j] : j;
  }
  path.reverse();                                // top to bottom
  return path;
}

// Teeth first.
const teeth = new Map();                         // `${net}|${r}` -> {path, ext}
let stripFailures = 0;
for (const net of BUS) {
  for (let r = 0; r < rowYs.length; r++) {
    const [ylo, yhi] = strat(net, rowYs[r]);
    const path = toothPath(ylo, yhi);
    if (!path) { stripFailures++; continue; }
    teeth.set(`${net}|${r}`, { path, ext: [path[0][0], path[path.length - 1][0]] });
  }
}

/** y of a tooth's centreline at x. */
function laneYAt(tooth, x) {
  const p = tooth.path;
  if (x <= p[0][0]) return p[0][1];
  for (let i = 0; i + 1 < p.length; i++) {
    if (x <= p[i + 1][0]) {
      const t = (x - p[i][0]) / (p[i + 1][0] - p[i][0]);
      return p[i][1] + t * (p[i + 1][1] - p[i][1]);
    }
  }
  return p[p.length - 1][1];
}

// Spines. Each must CROSS every one of its net's teeth (T-junctions join the
// comb), so its x-window starts just inside the innermost tooth end on that
// net's side and is a couple of mm wide.
let spineFailures = 0;
const spines = new Map();                        // net -> path
for (const net of BUS) {
  const own = [...teeth.keys()].filter((k) => k.startsWith(net)).map((k) => teeth.get(k));
  if (!own.length) { spineFailures++; continue; }
  const left = net === 'GND';
  const inner = left
    ? Math.max(...own.map((t) => t.ext[0]))
    : Math.min(...own.map((t) => t.ext[1]));
  const [ylo, yhi] = [
    Math.min(...own.map((t) => t.path[0][1], Infinity)) - 0.4,
    Math.max(...own.map((t) => t.path[t.path.length - 1][1], -Infinity)) + 0.4,
  ];
  const yAll = own.flatMap((t) => t.path.map((p) => p[1]));
  const y0 = Math.min(...yAll), y1 = Math.max(...yAll);
  const path = left
    ? spinePath(inner + 0.2, inner + 3.2, y0, y1)
    : spinePath(inner - 3.2, inner - 0.2, y0, y1);
  if (!path) { spineFailures++; continue; }
  spines.set(net, path);
}

/** x of a spine at y. */
function spineXAt(path, y) {
  if (y <= path[0][1]) return path[0][0];
  for (let i = 0; i + 1 < path.length; i++) {
    if (y <= path[i + 1][1]) {
      const t = (y - path[i][1]) / (path[i + 1][1] - path[i][1] || 1);
      return path[i][0] + t * (path[i + 1][0] - path[i][0]);
    }
  }
  return path[path.length - 1][0];
}

// Emit: teeth clipped away from the FOREIGN spine, plus the spines.
const trunkSegs = [];                            // {net, w, pts:[[x,y],...]}
// Collapse to the fewest vertices that stay within EPS of the grid path
// (Douglas-Peucker). Not cosmetic: freerouting normalizes carried wiring by
// RECURSIVE segment combining, and hundreds of 0.25 mm grid steps per tooth
// blow its stack (StackOverflowError in PolylineTrace.combine) at any -Xss.
// The corridor is padded by more than EPS, so the decimated path stays legal.
function collapse(pts, eps = 0.04) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = ptSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > eps && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** First intersection of a tooth's polyline with its own spine, walking the
 *  tooth from its spine-side end. A T made of CROSSING segments is connected
 *  copper to KiCad but a same-net tracks-crossing VIOLATION to freerouting --
 *  and a violation on protected wiring stalls its autorouter on pass one. So
 *  the junction becomes an explicit shared vertex in both polylines. */
function xsect(a0, a1, b0, b1) {
  const d1x = a1[0] - a0[0], d1y = a1[1] - a0[1];
  const d2x = b1[0] - b0[0], d2y = b1[1] - b0[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b0[0] - a0[0]) * d2y - (b0[1] - a0[1]) * d2x) / den;
  const u = ((b0[0] - a0[0]) * d1y - (b0[1] - a0[1]) * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [a0[0] + t * d1x, a0[1] + t * d1y];
}
const spineJoins = new Map();                    // net -> [[x,y] junction points]
for (const [k, tooth] of teeth) {
  const net = k.split('|')[0];
  const own = spines.get(net);
  const other = BUS.find((n) => n !== net);
  const foreign = spines.get(other);
  let [x0, x1] = tooth.ext;
  // clip the DEAD end away from the foreign spine's whole x-range
  if (foreign) {
    if (other === 'GND') x0 = Math.max(x0, Math.max(...foreign.map((p) => p[0])) + 0.8);
    else x1 = Math.min(x1, Math.min(...foreign.map((p) => p[0])) - 0.8);
  }
  // clip the LIVE end at the junction with the own spine, as a shared vertex
  let joint = null;
  if (own) {
    outer: for (let i = 0; i + 1 < own.length; i++) {
      const pts = tooth.path;
      for (let j = 0; j + 1 < pts.length; j++) {
        const p = xsect(own[i], own[i + 1], pts[j], pts[j + 1]);
        if (p) { joint = p; break outer; }
      }
    }
  }
  if (joint) {
    if (!spineJoins.has(net)) spineJoins.set(net, []);
    spineJoins.get(net).push(joint);
    if (net === 'GND') x0 = joint[0]; else x1 = joint[0];
  }
  if (x1 - x0 < 2) continue;
  const pts = [];
  const push = (x) => pts.push([x, laneYAt(tooth, x)]);
  push(x0);
  for (const [x] of tooth.path) if (x > x0 + 1e-6 && x < x1 - 1e-6) push(x);
  push(x1);
  // the junction is the exact endpoint, not an interpolation of it
  if (joint) { if (net === 'GND') pts[0] = joint; else pts[pts.length - 1] = joint; }
  tooth.clip = [x0, x1];
  tooth.emitPts = pts;                           // emitted after the drops,
  tooth.net = net;                               // with via points spliced in
}

// --- clusters: the pads of each bus net, grouped by cell --------------------
const clusters = new Map();
for (const fp of board.fps) {
  for (const pd of fp.pads) {
    if (!BUS.includes(pd.netName)) continue;
    const x = fp.x + pd.dx, y = fp.y + pd.dy;
    let ci = 0, bd = Infinity;
    for (let k = 0; k < coils.length; k++) {
      const d = Math.hypot(coils[k][0] - x, coils[k][1] - y);
      if (d < bd) { bd = d; ci = k; }
    }
    const id = `${pd.netName}|${ci}`;
    if (!clusters.has(id)) clusters.set(id, { net: pd.netName, cell: ci, pads: [] });
    clusters.get(id).pads.push({ x, y });
  }
}

// --- stubs + drops ----------------------------------------------------------
const field = makeField(board, (ref, pad, netName) => netName);
for (const t of board.tracks) {
  field.traces.push({ net: board.nets.get(t.net) || '', pts: [t.a, t.b], width: t.width, layer: t.layer });
}
for (const t of teeth.values()) {
  if (t.emitPts) field.traces.push({ net: t.net, pts: t.emitPts, width: LANE, layer: TRUNK_LAYER });
}
for (const [net, path] of spines) field.traces.push({ net, pts: path, width: LANE, layer: TRUNK_LAYER });
viaLegal.traces = field.traces;

const EDGE = { dist: distToOutline, min: FAB.edgeClearance };
const laid = [];
const stats = { clusters: 0, connected: 0, noVia: 0, noStub: 0, ties: 0, tiesFailed: 0 };
const rowOf = (ci) => rowYs.findIndex((y) => Math.abs(y - coils[ci][1]) < 0.01);

for (const cl of [...clusters.values()].sort((a, b) => a.cell - b.cell)) {
  stats.clusters++;
  const stubW = 0.15;                            // power stubs
  const anchor = cl.pads.reduce((a, p) => ({ x: a.x + p.x / cl.pads.length, y: a.y + p.y / cl.pads.length }), { x: 0, y: 0 });
  cl.pads.sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y));
  // Tie the cluster together on B.Cu. Ties thread between neighbouring pads,
  // so they use the thinnest legal stub regardless of the net's power width.
  const untied = [];
  for (let i = 1; i < cl.pads.length; i++) {
    stats.ties++;
    const r = prewire([{ net: cl.net, coilNet: null, a: [cl.pads[i - 1].x, cl.pads[i - 1].y], b: [cl.pads[i].x, cl.pads[i].y], layer: PAD_LAYER }],
      field, { clearance: CLR, width: 0.1, edge: EDGE });
    if (r.done) laid.push(...r.laid); else untied.push(cl.pads[i]);
  }
  // candidate teeth: this cell's own row, then the neighbours'
  const r = rowOf(cl.cell);
  const candTeeth = [r, r + 1, r - 1]
    .map((rr) => teeth.get(`${cl.net}|${rr}`))
    .filter((t) => t && t.clip);
  let done = false, sawVia = false;
  for (const tooth of candTeeth) {
    // slide along the tooth, nearest x first, far enough to cross two full
    // column periods (the legal slots live on the gutters, ~4.2 mm out)
    for (let k = 0; k < 134 && !done; k++) {
      const x = anchor.x + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.15;
      if (x < tooth.clip[0] || x > tooth.clip[1]) continue;
      const y = laneYAt(tooth, x);
      if (!viaLegal(x, y, cl.net)) continue;
      sawVia = true;
      // any pad of the cluster may host the stub; nearest to the slot first
      const srcs = [...cl.pads].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
      let w = { done: 0, laid: [] };
      for (const s2 of srcs) {
        w = prewire([{ net: cl.net, coilNet: null, a: [s2.x, s2.y], b: [x, y], layer: PAD_LAYER }],
          field, { clearance: CLR, width: stubW, edge: EDGE });
        if (w.done) break;
      }
      if (!w.done) { whyNot.prewire++; continue; }
      laid.push(...w.laid);
      newVias.push({ x, y, net: cl.net });
      field.vias.push({ x, y, r: vR, net: cl.net });
      // a pad the chain ties missed gets a second chance against the via
      for (const p of untied) {
        const t = prewire([{ net: cl.net, coilNet: null, a: [p.x, p.y], b: [x, y], layer: PAD_LAYER }],
          field, { clearance: CLR, width: 0.1, edge: EDGE });
        if (t.done) { laid.push(...t.laid); stats.retied = (stats.retied || 0) + 1; }
        else stats.tiesFailed++;
      }
      done = true;
    }
    if (done) break;
  }
  if (!done) stats.tiesFailed += untied.length;
  if (done) stats.connected++;
  else if (sawVia) stats.noStub++;
  else stats.noVia++;
  if (!done && process.env.DEBUG) {
    console.error(`miss ${cl.net}|cell${cl.cell} at (${anchor.x.toFixed(1)},${anchor.y.toFixed(1)}) row ${rowOf(cl.cell)} ${sawVia ? 'no-stub' : 'no-via'}`);
  }
}

// The trunk copper itself, LAST: each drop via lies mid-lane on its tooth,
// and freerouting only understands the junction if the via point is a real
// vertex of the wire -- so the teeth are emitted with their drop points
// spliced in.
for (const t of teeth.values()) {
  if (!t.emitPts) continue;
  const drops = newVias
    .filter((v) => v.net === t.net && Math.abs(laneYAt(t, v.x) - v.y) < 1e-6
      && v.x > t.clip[0] - 1e-9 && v.x < t.clip[1] + 1e-9)
    .map((v) => [v.x, v.y]);
  // decimate FIRST; the drop points then go in as exact vertices (the tiny
  // kink this leaves is under the corridor's slack)
  const pts = collapse([...t.emitPts]);
  for (const d of drops) {
    let at = pts.length - 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (d[0] >= pts[i][0] - 1e-9 && d[0] <= pts[i + 1][0] + 1e-9) { at = i + 1; break; }
    }
    if (pts.every((p) => Math.hypot(p[0] - d[0], p[1] - d[1]) > 1e-9)) pts.splice(at, 0, d);
  }
  trunkSegs.push({ net: t.net, w: LANE, pts });
}
for (const [net, path] of spines) {
  // splice each tooth's junction in as a real vertex of the spine
  const joins = (spineJoins.get(net) || []).slice();
  const pts = collapse(path);
  for (const j of joins) {
    if (pts.some((p) => Math.hypot(p[0] - j[0], p[1] - j[1]) < 1e-9)) continue;
    pts.push(j);
  }
  pts.sort((a, b) => a[1] - b[1]);               // y-monotone spine
  trunkSegs.push({ net, w: LANE, pts });
}

// --- emit -------------------------------------------------------------------
const out = [];
for (const s of trunkSegs) {
  for (let i = 0; i + 1 < s.pts.length; i++) {
    const [ax, ay] = s.pts[i], [bx, by] = s.pts[i + 1];
    if (Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9) continue;
    out.push(`  (segment (start ${f(ax)} ${f(ay)}) (end ${f(bx)} ${f(by)}) (width ${f(s.w)}) (layer "${TRUNK_LAYER}") (net ${netNum.get(s.net)}))`);
  }
}
for (const t of laid) {
  for (let i = 0; i + 1 < t.pts.length; i++) {
    const [ax, ay] = t.pts[i], [bx, by] = t.pts[i + 1];
    if (Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9) continue;
    out.push(`  (segment (start ${f(ax)} ${f(ay)}) (end ${f(bx)} ${f(by)}) (width ${f(t.width)}) (layer "${t.layer}") (net ${netNum.get(t.net)}))`);
  }
}
for (const v of newVias) {
  out.push(`  (via (at ${f(v.x)} ${f(v.y)}) (size ${f(vDia)}) (drill ${f(vDrill)}) (layers "F.Cu" "B.Cu") (net ${netNum.get(v.net)}))`);
}

const txt = board.txt;
const cut = txt.lastIndexOf('\n)');
writeFileSync(outPath, txt.slice(0, cut) + '\n' + out.join('\n') + txt.slice(cut));

console.log(JSON.stringify({
  nets: BUS, trunkLayer: TRUNK_LAYER, rows: rowYs.length, stripFailures, spineFailures,
  trunkSegments: trunkSegs.length, stubTraces: laid.length, dropVias: newVias.length,
  ...stats, whyNot,
}, null, 1));
console.log(`wrote ${outPath}`);

// NOT DONE HERE: VLOGIC and SCLK/RCLK/OE_N. They touch only the 42 registers,
// 32 sensors and the header; the chain order is already a serpentine of
// physical neighbours, so the right construction is a small bundle following
// that chain through the quad corridors, with B.Cu jumpers where it must
// cross a comb tooth. Until that is built they stay in the router's netlist
// like everything else.
