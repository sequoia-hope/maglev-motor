// CONSTRUCT the centre quad's bus lanes AND power combs instead of routing
// them: freerouting sprawls over whatever board it is given first and every
// carry mode composes badly (see single-cell-periodic-routing, lane-stage
// diagnosis), so everything with a known shape is drawn here and only the
// genuinely combinatorial work (coil terminals, PWM fanout, register drops)
// is left to the router, with this copper as exact keepouts.
//
// LANES: with the cellspec v3 interleaved ladder every lane is a straight
// horizontal run on the inner electronics layer through its own seam vias.
// Register connections are B.Cu TAPS on the nets' own via barrels (the via
// is the layer portal); DATA_E gets ONE constructed via in the empty DATA
// slot of the quad-internal seam.
//
// POWER: VBUS/GND own the two inner ladder slots (+/-0.42). Each row gets an
// In12 trunk seam-to-seam at its slot offset with a per-cell JOG around the
// centre-bay ring (ring vias reach +/-0.615; the only clear In12 bands are
// -1.05, between the ring and the SCLK run, and +1.02, between the ring and
// the SDA run). Each cell gets a B.Cu TOOTH tree joining its U/C power pads
// to its own seam via barrel; the register cell's VBUS tooth detours around
// the SR pad field, and the register's own GND pad (SR.1) is left to the
// router as a tap drop like the lanes.
//
//   node lanegen.mjs [board] [outSes]
// Writes <out>.ses (freerouting-session-formatted constructed copper),
// <base>.taps.json, <base>.lanepins.json. Verifies every clearance
// numerically and exits 1 on any violation -- constructed copper is only
// trustworthy because of this.
import { readFileSync, writeFileSync } from 'fs';
import { makeStator } from '../src/coils.js';
import { FAB } from '../src/kicad.js';
import { readBoard } from './mkdsn.mjs';
import { SEAM_SIGNALS } from './cellspec.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));

const boardPath = process.argv[2] || 'qlane.kicad_pcb';
const outSes = process.argv[3] || 'qlane.lanes.ses';
const base = outSes.replace(/\.ses$/, '');
const spec = JSON.parse(readFileSync(boardPath.replace(/\.kicad_pcb$/, '.quads.json'), 'utf8'));
const { quads, centreQuad } = spec;
const Q = quads[centreQuad];

const LANE_LAYER = 'In12.Cu';
const PAD_LAYER = 'B.Cu';
const W = 0.1;                                   // constructed trace width
const CLR = FAB.minClearance;

const board = readBoard(boardPath);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const pitch = cfg.stator.coilPitch * 1000;
const coils = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);

// --- anchors: same classification as quadroute --------------------------------
const inQuad = new Set(Q.cells);
const anchors = new Map();                       // net -> [{x, y}]
for (const i of stator.coils.keys()) {
  const e = stator.coils.findIndex((d) => Math.abs(d.x * 1000 - stator.coils[i].x * 1000 - pitch) < 0.01 && Math.abs(d.y - stator.coils[i].y) < 0.01);
  if (e < 0) continue;
  if (!inQuad.has(i) && !inQuad.has(e)) continue;
  for (const s of SEAM_SIGNALS) {
    const fx = coils[i][0] + s.at[0], fy = coils[i][1] - s.at[1];
    let nm = `${s.net}_C`;
    if (s.net === 'DATA') {
      if (inQuad.has(i) && inQuad.has(e)) continue;
      nm = inQuad.has(e) ? 'DATA_W' : 'DATA_E';
    }
    // only positions where quadgen really placed a via (seamOK can block one),
    // SNAPPED to the via actually on the board so runs touch barrels exactly
    const bv = board.vias.find((v) => Math.hypot(v.x - fx, v.y - fy) < 0.02);
    if (!bv) continue;
    if (!anchors.has(nm)) anchors.set(nm, []);
    anchors.get(nm).push({ x: bv.x, y: bv.y });
  }
}

// --- cell frames ---------------------------------------------------------------
// runs/teeth are designed in the CELL FRAME (x east, y-up offsets from the
// coil centre); toB() maps to board coordinates (KiCad y-down).
const swCell = Q.cells[0];
const [c78x, c78y] = coils[swCell];
const off = Object.fromEntries(SEAM_SIGNALS.map((s) => [s.net, s.at]));
const at = (net) => [c78x + off[net][0], c78y - off[net][1]];
function pt([x, y]) { return { x: +x.toFixed(3), y: +y.toFixed(3) }; }

// --- lane runs -------------------------------------------------------------------
const LANES = ['SCLK_C', 'RCLK_C', 'OE_N_C', 'VLOGIC_C', 'SDA_C', 'SCL_C', 'DATA_E'];
const runs = [];                                 // {net, layer, pts:[[x,y],...]}
const cvias = [];                                // {net, x, y} constructed vias
const rowKey = (y) => y.toFixed(2);
for (const net of LANES) {
  const as = anchors.get(net) || [];
  const rows = new Map();
  for (const a of as) {
    const k = rowKey(a.y);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(a);
  }
  for (const [, group] of rows) {
    if (group.length < 2 && net !== 'DATA_E') continue;   // lone via: spine/tap territory
    group.sort((a, b) => a.x - b.x);
    let x0 = group[0].x, x1 = group[group.length - 1].x;
    const y = group[0].y;
    if (net === 'DATA_E') {
      // extend from the east boundary anchor west to the portal via in the
      // unused DATA slot of the quad-internal seam
      const [px, py] = at('DATA');
      if (Math.abs(py - y) > 0.01) { console.error(`DATA_E portal y mismatch ${py} vs ${y}`); process.exit(1); }
      x0 = Math.min(x0, px);
      cvias.push({ net, x: px, y: py });
    }
    if (x1 - x0 < 0.01) continue;
    runs.push({ net, layer: LANE_LAYER, pts: [[x0, y], [x1, y]] });
  }
}

// --- power combs -----------------------------------------------------------------
// Templates in the cell frame (y-up). Constants derive from the measured
// geometry: ring vias at (+-0.68,-0.075), (+-0.3..0.42,+0.531/-0.615);
// U pads 0.9x0.6 in columns x=0.393/2.593 rows y=1.446/2.396/3.346;
// C pads 0.5x0.4 at (1.593/2.593, 0.596); ladder columns A x=3.943 (east) /
// -4.524 (west), B x=4.513 (east) / -3.954 (west).
const POWER = ['VBUS_C', 'GND_C'];
const T = {
  VBUS_C: {
    // The via-link hangs off C.1's EAST side and dives through the C.1/U.5
    // corridor (x 1.993): a link at the riser's foot (x 1.10) walled the
    // pocket's whole southern exit and the PWM fanout lost 9 of 15 nets to
    // it. This shape leaves a 0.6 mm south corridor at x 1.24..1.85, clears
    // SR.16's corner by 0.05, and works unmodified in the register cell.
    trunk: [[-4.524, -0.424], [-1.30, -0.424], [-1.30, -1.05], [1.30, -1.05], [1.30, -0.424], [3.943, -0.424]],
    teeth: [
      [[1.10, 0.596], [1.10, 2.396], [0.75, 2.396]],    // riser past U.6, into U.4
      [[1.10, 0.596], [1.50, 0.596]],                    // into C.1
      [[1.79, 0.596], [1.993, 0.596], [1.993, -0.424], [3.943, -0.424]],  // C.1 east -> own seam via
    ],
    teethReg: null,
  },
  GND_C: {
    trunk: [[-3.954, 0.416], [-1.30, 0.416], [-1.30, 1.02], [1.30, 1.02], [1.30, 0.416], [4.513, 0.416]],
    teeth: [
      [[4.513, 0.416], [3.60, 0.416], [3.42, 0.596], [3.23, 0.596], [2.70, 0.596]],  // into C.2
      [[3.23, 0.596], [3.23, 2.396], [2.90, 2.396]],     // riser past U.5, into U.3
    ],
    teethReg: null,                                      // generic works (SR is south-west)
  },
};
for (const ci of Q.cells) {
  const [ccx, ccy] = coils[ci];
  const toB = (p) => [+(ccx + p[0]).toFixed(3), +(ccy - p[1]).toFixed(3)];
  for (const net of POWER) {
    runs.push({ net, layer: LANE_LAYER, pts: T[net].trunk.map(toB) });
    const teeth = (ci === swCell && T[net].teethReg) ? T[net].teethReg : T[net].teeth;
    for (const tp of teeth) runs.push({ net, layer: PAD_LAYER, pts: tp.map(toB) });
  }
}

// --- coil_78_B In12 dogleg -------------------------------------------------------
// The 2026-07-30 winding fix walked every cell's OUT terminal from the SE flat
// to the SW flat (endShiftsFor: terminals inherit the accumulated S[N-1], and
// both restore directions are structurally impossible -- a negative shift
// recreates the 845 tab chords, a forward whole-lap ride overlaps the rAt
// clamp coast; coilcheck refused it with 2688 pairs). Only the REGISTER cell
// cares: its south-west field is over-subscribed (GND drop, VLOGIC link, stub
// fanout, both 79-descents, PWMA_91's wedge), and three harness variants plus
// a weighted-BFS proof all showed a SW-terminal coil trunk evicts 2-4 of
// those constructions; freerouting fails the net in every configuration too.
// So the coil leaves B.Cu entirely: its terminal via is a through-hole, and
// the In12 inter-row band south of the lane stack (OE_N, the last lane, sits
// at cy+2.52) is empty except via barrels. Ride it east under the whole west
// field to a constructed routing via in the SE gutter -- the site probed
// legal against the r1 DSN keepouts (134 candidates; this one >= 0.73 from
// every hole) -- which is where the OLD east-around corridor to U78.6 begins.
// PROBE WARNING (cost 8 real DRC hits, 2026-07-30): the r1 DSN carries only
// the QUAD's winding keepouts and no component pads -- sites that pass its
// probe can still land in a NEIGHBOUR cell's territory (a via at (69.45,
// 69.90) hit cell 66's rim fillet arcs and U66.2's pad; the row-1 cells' U
// pockets sit at their N vertices, y ~69.5-70.5). Probe any future site
// against the FULL board's copper, not the routing proxy. Also measured and
// CLOSED (same day): constructing the pocket escapes (OE_N / SCLK / DATA_E
// in any combination, three verified corridor layerings) always displaces
// at least as many router successes (RCLK_C, PWMA_91, even coil_79_B) --
// the register pocket is saturated at this SR placement; the remaining
// escapes wait on the SR re-rotation co-design.
// The same-net crossover barrels en route are MID-WINDING taps: touching one
// shorts turns; they are not ownVia-exempt, so the verifier holds them at
// full via clearance (dodge at (1.865,2.871) clears the (1.87,3.29) barrel
// by 0.418 vs the 0.39 floor).
const coilViaSW = (() => {
  const cb = (x, y) => [+(c78x + x).toFixed(3), +(c78y + y).toFixed(3)];
  const net = `coil_${Q.cells[0]}_B`;
  const via = cb(2.610, 3.071);
  const legPts = [
    cb(-2.405, 2.985),                     // J78.OUT barrel centre
    cb(-1.990, 3.021), cb(0.910, 3.021),   // straight run south of the lanes
    cb(1.865, 2.871),                      // north dodge past the (1.87,3.29) barrel
    cb(2.360, 2.921), via,                 // into the via land
  ];
  const emitLeg = () => {
    runs.push({ net, layer: LANE_LAYER, pts: legPts });
    cvias.push({ net, x: via[0], y: via[1] });
  };
  // SR_SWEEP: a candidate register may leave the SW terminal's west field
  // free, making a direct B.Cu path cheaper than the dogleg -- the leg is
  // emitted on demand from the harness block instead (or not at all).
  if (!process.env.SR_SWEEP) emitLeg();
  return { x: via[0], y: via[1], emitLeg };
})();

// --- taps ----------------------------------------------------------------------
// Tap-to-seam assignment is about ESCAPE, not distance: a tap must leave
// toward the register without threading the seam's OTHER column (0.17 mm
// edge margins that the first-routed drops then seal). Column-A nets tap the
// EAST seam and escape west past nothing; column-B nets (RCLK, OE_N, VLOGIC)
// tap the WEST seam and escape east past nothing. GND's tap (for the
// register's own SR.1 pad) is the SW cell's west GND via -- the comb trunk
// already passes through that barrel.
const west = (net) => pt([at(net)[0] - pitch, at(net)[1]]);
const taps = [
  { net: 'SCLK_C', ...pt(at('SCLK')) },
  { net: 'RCLK_C', ...west('RCLK') },
  { net: 'OE_N_C', ...west('OE_N') },
  { net: 'VLOGIC_C', ...west('VLOGIC') },
  { net: 'DATA_W', ...pt([at('DATA')[0] - pitch, at('DATA')[1]]) },
  { net: 'DATA_E', ...pt(at('DATA')) },
  { net: 'GND_C', ...west('GND') },
];
// Register pads whose west trek is geometrically impossible (the bay ring
// seals the under-body channel at their drop points) hop EAST to a tap on the
// quad-internal seam instead -- the constructed lane joins that barrel to the
// west one. CRITICAL ENCODING RULE (measured, run of 2026-07-30 00:04): every
// router net must be exactly the TWO pins of one real job. Presenting west
// AND internal taps on one net makes freerouting route the lane's own 8.5 mm
// span as a phantom third connection, and that megaroute breaks nets that
// otherwise complete (SCLK_C, DATA_E). So VLOGIC's two jobs get two nets
// (VLOGIC_CW: constructed pad-4 stub <-> west tap; VLOGIC_CE: bare pad 16 <->
// internal tap), OE_N moves wholly east (its west tap disappears -- the seam
// via reverts to a keepout), and RCLK keeps its proven west-only pair.
if (!process.env.SR_SWEEP) {
  taps.find((t) => t.net === 'VLOGIC_C').net = 'VLOGIC_CW';
  Object.assign(taps.find((t) => t.net === 'OE_N_C'), pt(at('OE_N')));
  taps.push({ net: 'VLOGIC_CE', ...pt(at('VLOGIC')) });
} else {
  // SR_SWEEP: the side assignments above are measured against the COMMITTED
  // register spot. For a candidate placement, each control net taps the seam
  // barrel nearer its own SR pad (escape is what the side rule was about, and
  // pad proximity is its placement-generic proxy). Pad 4 keeps the net name
  // VLOGIC_C -- that is quadroute's hardcoded override -- and VLOGIC_CE (pad
  // 16) takes whichever VLOGIC barrel pad 4 left free.
  const srF = board.fps.find((f2) => f2.ref === `SR${centreQuad}`);
  const srPad = (nm) => {
    const p2 = srF.pads.find((q) => q.name === nm);
    return [srF.x + p2.dx, srF.y + p2.dy];
  };
  const nearer = (net, padName) => {
    const [px, py] = srPad(padName);
    const east = pt(at(net)), wst = west(net);
    return Math.hypot(east.x - px, east.y - py) <= Math.hypot(wst.x - px, wst.y - py)
      ? [east, wst] : [wst, east];
  };
  // GND too: the comb trunk passes through BOTH seams' GND barrels, so the
  // register's SR.1 drop may tap whichever is nearer
  for (const [net, tapNet, padName] of [['SCLK', 'SCLK_C', '6'], ['RCLK', 'RCLK_C', '8'], ['OE_N', 'OE_N_C', '10'], ['GND', 'GND_C', '1']]) {
    Object.assign(taps.find((t) => t.net === tapNet), nearer(net, padName)[0]);
  }
  const [v4, vOther] = nearer('VLOGIC', '4');
  Object.assign(taps.find((t) => t.net === 'VLOGIC_C'), v4);
  taps.push({ net: 'VLOGIC_CE', ...vOther });
}
for (const t of taps) {
  if (t.kind === 'stub') continue;               // fanout tap pads sit on stub ends, not barrels
  const bv = board.vias.find((v) => Math.hypot(v.x - t.x, v.y - t.y) < 0.02);
  const cons = cvias.some((v) => Math.hypot(v.x - t.x, v.y - t.y) < 0.02);
  if (!bv && !cons) { console.error(`tap ${t.net} at ${t.x},${t.y}: no via there`); process.exit(1); }
  if (bv) { t.x = bv.x; t.y = bv.y; }             // snap to the real barrel
}

// --- PWM harness (and the obstacle-field A* that draws it) --------------------
// Eight bespoke B.Cu paths from the register's output pads to the bridges.
// Hand-derived corridors die in the inter-row via minefield, so this is a
// tiny deterministic grid router: every barrel, pad and constructed segment
// is rasterised at its EXACT clearance, each PWM is A*-routed farthest-first
// on B.Cu only, and every found path immediately becomes an obstacle for the
// next. The numeric verifier below re-checks the result like everything
// else. Before the PWMs route, each cell's coil corridor (J.OUT -> U.6, the
// one non-trivial coil connection) is routed the same way and reserved as a
// VIRTUAL obstacle -- not emitted -- so stage R1 still has room.
// GRID 0.025: the harness corridors include real 0.09-0.13 mm windows (the
// east thread between the GND riser and the A-column, the crossover above the
// U-column tops) which a 0.05 raster seals shut. Safety margins scale with
// the grid (corner-cut error is GRID/2/sqrt(2)); the exact verifier below is
// what actually holds the fab line.
const GRID = 0.025;
const gx0 = c78x - 6.5, gy0 = c78y - 7.332 - 6.5;   // covers both rows + margin
const gw = Math.ceil((2 * 8.467 + 13) / GRID), gh = Math.ceil((7.332 + 13) / GRID);
const blocked = new Uint8Array(gw * gh);         // 1 = hard obstacle
const gi = (ix, iy) => iy * gw + ix;
const toIx = (x) => Math.round((x - gx0) / GRID), toIy = (y) => Math.round((y - gy0) / GRID);
const blockDisc2 = (x, y, r, buf, val) => {
  const iR = Math.ceil(r / GRID);
  const cxI = toIx(x), cyI = toIy(y);
  for (let iy = Math.max(0, cyI - iR); iy <= Math.min(gh - 1, cyI + iR); iy++) {
    for (let ix = Math.max(0, cxI - iR); ix <= Math.min(gw - 1, cxI + iR); ix++) {
      const dx = (ix - cxI) * GRID, dy = (iy - cyI) * GRID;
      if (dx * dx + dy * dy <= r * r) buf[gi(ix, iy)] = val;
    }
  }
};
const blockDisc = (x, y, r, buf) => blockDisc2(x, y, r, buf, 1);
const blockSeg = (ax, ay, bx, by, r, buf) => {
  const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / (GRID / 2)));
  for (let k = 0; k <= n; k++) blockDisc(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, r, buf);
};
// A* over the grid, 8 directions, slight turn penalty so paths stay straight.
// `pref` (optional Uint8 grid, 1 = off-corridor) adds a soft per-step cost:
// the search strongly prefers the caller's corridor but may still deviate
// through legal space when the corridor is locally blocked.
const astar = (sx, sy, ex, ey, allow, foreign, pref) => {
  const sI = [toIx(sx), toIy(sy)], eI = [toIx(ex), toIy(ey)];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const key = (ix, iy) => gi(ix, iy);
  // Float64, NOT Float32: a rounded-down stored g makes every popped entry
  // test as stale (g0 > gS) and the whole frontier silently dies.
  const gS = new Float64Array(gw * gh).fill(Infinity);
  const from = new Int32Array(gw * gh).fill(-1);
  const fromDir = new Int8Array(gw * gh).fill(-1);
  // binary min-heap: the 0.025 grid explores hundreds of thousands of cells
  // and a linear-scan open list is quadratic in that
  const open = [[Math.hypot(sI[0] - eI[0], sI[1] - eI[1]), 0, sI[0], sI[1], -1]];
  const heapUp = (i) => {
    while (i > 0) {
      const p2 = (i - 1) >> 1;
      if (open[p2][0] <= open[i][0]) break;
      [open[p2], open[i]] = [open[i], open[p2]];
      i = p2;
    }
  };
  const heapPop = () => {
    const top = open[0], last = open.pop();
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < open.length && open[l][0] < open[m][0]) m = l;
        if (r < open.length && open[r][0] < open[m][0]) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i], open[m]];
        i = m;
      }
    }
    return top;
  };
  gS[key(...sI)] = 0;
  const isFree = (ix, iy) => (!blocked[gi(ix, iy)] || (allow && allow[gi(ix, iy)])) && !(foreign && foreign[gi(ix, iy)]);
  while (open.length) {
    const [, g0, ix, iy, dir0] = heapPop();
    if (g0 > gS[key(ix, iy)]) continue;
    if (ix === eI[0] && iy === eI[1]) {
      const pts = [];
      let cur = key(ix, iy);
      let px = ix, py = iy;
      while (cur >= 0) {
        pts.push([gx0 + px * GRID, gy0 + py * GRID]);
        cur = from[key(px, py)];
        if (cur < 0) break;
        px = cur % gw; py = Math.floor(cur / gw);
      }
      pts.reverse();
      // decimate collinear
      const out = [pts[0]];
      for (let i = 1; i + 1 < pts.length; i++) {
        const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
        if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-9) out.push(b);
      }
      out.push(pts[pts.length - 1]);
      return out;
    }
    for (let d = 0; d < 8; d++) {
      const nx = ix + DIRS[d][0], ny = iy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const endFree = (nx === eI[0] && ny === eI[1]) || (nx === sI[0] && ny === sI[1]);
      if (!endFree && !isFree(nx, ny)) continue;
      const step = (d < 4 ? 1 : Math.SQRT2) + (dir0 >= 0 && d !== dir0 ? 0.9 : 0)
        + (pref && pref[gi(nx, ny)] ? 1.2 : 0);
      const ng = g0 + step;
      if (ng < gS[key(nx, ny)] - 1e-9) {
        gS[key(nx, ny)] = ng;
        from[key(nx, ny)] = key(ix, iy);
        fromDir[key(nx, ny)] = d;
        open.push([ng + Math.hypot(nx - eI[0], ny - eI[1]), ng, nx, ny, d]);
        heapUp(open.length - 1);
      }
    }
  }
  return null;
};

// rasterise the world for a 0.1 mm B.Cu trace: barrels, constructed copper,
// and every pad as its ROTATED RECTANGLE (a conservative disc walls in the
// register's 0.5 mm-pitch pad fan)
const blockRect = (p2, inflate, buf, val = 1) => {
  const a = (p2.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const R = Math.hypot(p2.w, p2.h) / 2 + inflate;
  const cxI = toIx(p2.x), cyI = toIy(p2.y), iR = Math.ceil(R / GRID);
  for (let iy = Math.max(0, cyI - iR); iy <= Math.min(gh - 1, cyI + iR); iy++) {
    for (let ix = Math.max(0, cxI - iR); ix <= Math.min(gw - 1, cxI + iR); ix++) {
      const dx = gx0 + ix * GRID - p2.x, dy = gy0 + iy * GRID - p2.y;
      const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
      if (Math.abs(lx) <= p2.w / 2 + inflate && Math.abs(ly) <= p2.h / 2 + inflate) buf[gi(ix, iy)] = val;
    }
  }
};
const SAFE = 0.012;                              // static obstacles
const SAFE_P = 0.024;                            // path bands: BOTH paths corner-cut                               // grid-quantisation guard: a
// diagonal step between two legal cell centres can cut an obstacle corner by
// up to GRID/2/sqrt(2); rasterise everything that much fatter and let the
// exact verifier below hold the real 0.09 mm line.
const padsByNet = new Map();                     // board net name -> pad geoms
for (const fp of board.fps) {
  for (const p2 of fp.pads) {
    const g2 = { x: fp.x + p2.dx, y: fp.y + p2.dy, w: p2.w, h: p2.h, rot: -((fp.rot || 0) + (p2.ang || 0)) };
    if (!padsByNet.has(p2.netName)) padsByNet.set(p2.netName, []);
    padsByNet.get(p2.netName).push(g2);
    blockRect(g2, CLR + W / 2 + SAFE, blocked);
  }
}
for (const v of board.vias) blockDisc(v.x, v.y, v.size / 2 + CLR + W / 2 + SAFE, blocked);
for (const v of cvias) blockDisc(v.x, v.y, 0.25 + CLR + W / 2 + SAFE, blocked);
for (const s of runs) {
  if (s.layer !== PAD_LAYER) continue;
  for (let i = 0; i + 1 < s.pts.length; i++) blockSeg(...s.pts[i], ...s.pts[i + 1], W + CLR + SAFE, blocked);
}
// routing net N: N's own pads (by BOARD name: coil_78_A -> coil_78, RCLK_C ->
// RCLK) become passable, as does an optional starting via barrel
const boardName = (net) => net === 'DATA_W' ? `DATA_${centreQuad}`
  : net === 'DATA_E' ? `DATA_${centreQuad + 1}`
  : /^VLOGIC_C[WE]$/.test(net) ? 'VLOGIC'
  : net.replace(/_C$/, '').replace(/_[AB]$/, '');
const inPad = (x, y, g2, inflate = 0) => {
  const a = (g2.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const dx = x - g2.x, dy = y - g2.y;
  const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
  return Math.abs(lx) <= g2.w / 2 + inflate && Math.abs(ly) <= g2.h / 2 + inflate;
};
const allowFor = (net, startVia) => {
  const allow = new Uint8Array(gw * gh);
  const own = padsByNet.get(boardName(net)) || [];
  for (const g2 of own) blockRect(g2, CLR + W / 2 + SAFE, allow);
  if (startVia) blockDisc(startVia.x, startVia.y, 0.25 + CLR + W / 2 + SAFE, allow);
  // the allow region must not override NEIGHBOURING pads' clearance: in the
  // register's 0.5 mm fan the inflated rects overlap, and a path through the
  // overlap grazes the foreign pad (measured -0.056 on SR.4)
  const bn = boardName(net);
  for (const [nm, list] of padsByNet) {
    if (nm === bn) continue;
    for (const g2 of list) {
      for (const g3 of own) {
        if (Math.hypot(g2.x - g3.x, g2.y - g3.y) < 3) { blockRect(g2, CLR + W / 2 + SAFE, allow, 0); break; }
      }
    }
  }
  // ... nor foreign VIA barrels (a J pad's inflated rect reaches the gutter
  // via 0.7 mm away; measured -0.041 on coil_91_A)
  const nearOwn = (x, y) => own.some((g3) => Math.hypot(x - g3.x, y - g3.y) < 3)
    || (startVia && Math.hypot(x - startVia.x, y - startVia.y) < 3);
  const ownV = (v) => (anchors.get(net) || []).some((a) => Math.hypot(a.x - v.x, a.y - v.y) < 0.02)
    || cvias.some((c2) => c2.net === net && Math.hypot(c2.x - v.x, c2.y - v.y) < 0.02)
    || (startVia && Math.hypot(startVia.x - v.x, startVia.y - v.y) < 0.02)
    || own.some((g3) => inPad(v.x, v.y, g3));
  if (!process.env.NO_VIA_DENY) for (const v of board.vias) {
    if (!nearOwn(v.x, v.y) || ownV(v)) continue;
    blockDisc2(v.x, v.y, v.size / 2 + CLR + W / 2 + SAFE, allow, 0);
  }
  return allow;
};
// Harness copper is committed PER NET, not into `blocked`: each route then
// sees only OTHER nets' bands as obstacles (a blanket own-copper exemption
// let paths cross foreign clearance wherever it overlapped an own stub).
const committed = [];                            // {net, seg:[ax,ay,bx,by]}
const foreignScratch = new Uint8Array(gw * gh);
const foreignFor = (net) => {
  foreignScratch.fill(0);
  for (const c2 of committed) {
    if (c2.net === net) continue;
    blockSeg(c2.seg[0], c2.seg[1], c2.seg[2], c2.seg[3], W + CLR + SAFE_P, foreignScratch);
  }
  return foreignScratch;
};
const ownBarrels = [];                           // {net, x, y}: startVia barrels per constructed net
const prefFor = (guide) => {
  const g2 = new Uint8Array(gw * gh).fill(1);
  for (let i = 0; i + 1 < guide.length; i++) {
    const [ax, ay] = guide[i], [bx, by] = guide[i + 1];
    const L = Math.hypot(bx - ax, by - ay), n2 = Math.max(1, Math.ceil(L / (GRID / 2)));
    for (let k = 0; k <= n2; k++) blockDisc2(ax + ((bx - ax) * k) / n2, ay + ((by - ay) * k) / n2, 0.22, g2, 0);
  }
  return g2;
};
const routeNet = (net, from, to, { emit = true, startVia = null, guide = null, denyPads = null } = {}) => {
  if (!from || !to) { console.error(`HARNESS: missing endpoint for ${net}`); return false; }
  if (startVia) ownBarrels.push({ net, x: startVia.x, y: startVia.y });
  const allow = allowFor(net, startVia);
  // denyPads: same-BOARD-net pads this route must nevertheless keep clear of.
  // The coil halves are one KiCad net, so allowFor opens BOTH terminals' pads
  // -- copper grazing the far terminal would short across the whole winding,
  // and no checker downstream can see it (same net to DRC, constructed copper
  // to mkses). Used by the SR_SWEEP coil attempts, whose paths are unguided.
  if (denyPads) for (const [ref2, pd2] of denyPads) {
    const fp2 = board.fps.find((f3) => f3.ref === ref2);
    const p3 = fp2 && fp2.pads.find((q) => q.name === pd2);
    if (p3) blockRect({ x: fp2.x + p3.dx, y: fp2.y + p3.dy, w: p3.w, h: p3.h, rot: -((fp2.rot || 0) + (p3.ang || 0)) }, CLR + W / 2 + SAFE, allow, 0);
  }
  const p = astar(from[0], from[1], to[0], to[1], allow, foreignFor(net), guide && prefFor(guide));
  if (!p) {
    const sx = toIx(from[0]), sy = toIy(from[1]);
    const fg = foreignFor(net);
    let freeN = 0, allowN = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i2 = gi(sx + dx, sy + dy);
      if ((!blocked[i2] || allow[i2]) && !fg[i2]) freeN++;
      if (allow[i2]) allowN++;
    }
    console.error(`HARNESS: no path for ${net} (start 7x7: ${freeN} free, ${allowN} allowed)`);
    if (process.env.DUMP_GRID && (!process.env.DUMP_NET || process.env.DUMP_NET === net) && !routeNet.dumped) {
      routeNet.dumped = true;
      const merged = new Uint8Array(blocked);
      for (let i = 0; i < merged.length; i++) if (allow[i]) merged[i] = 0;
      writeFileSync(process.env.DUMP_GRID, JSON.stringify({
        gw, gh, gx0, gy0, GRID, from, to,
        rows: Array.from({ length: gh }, (_, iy) => Buffer.from(merged.subarray(iy * gw, (iy + 1) * gw)).toString('base64')),
        // static+allow alone can show start/goal CONNECTED while the A* fails:
        // the committed foreign bands are the wall. Dump them or the flood lies.
        fgRows: Array.from({ length: gh }, (_, iy) => Buffer.from(fg.subarray(iy * gw, (iy + 1) * gw)).toString('base64')),
      }));
      console.error(`grid dumped to ${process.env.DUMP_GRID}`);
    }
    return false;
  }
  if (emit) runs.push({ net, layer: PAD_LAYER, pts: p.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]) });
  for (let i = 0; i + 1 < p.length; i++) committed.push({ net, seg: [p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]] });
  return true;
};
const padAt = (ref, name) => {
  const fp = board.fps.find((f2) => f2.ref === ref);
  const p2 = fp && fp.pads.find((q) => q.name === name);
  return p2 ? [fp.x + p2.dx, fp.y + p2.dy] : null;
};
if (process.env.DUMP_STATIC) {
  // the raw obstacle field for a 0.1 mm B.Cu trace, before any harness work
  writeFileSync(process.env.DUMP_STATIC, JSON.stringify({
    gw, gh, gx0, gy0, GRID,
    rows: Array.from({ length: gh }, (_, iy) => Buffer.from(blocked.subarray(iy * gw, (iy + 1) * gw)).toString('base64')),
  }));
  console.error(`static grid dumped to ${process.env.DUMP_STATIC}`);
}
// --- closed-form nested register fanout ---------------------------------------
// The measured pocket truth (fanout.pocket.png): the south corridor is PINCHED
// SHUT at pad 2 (tip vs U65.1: 0.065 mm), so the even side's west-bound nets
// (VLOGIC 4/16, OE_N 10, DATA_W 12 -- the persistent R2 failures) have no
// outward B.Cu escape. But the strip UNDER the register body between the two
// pad rows' inner ends is 1.5 mm of legal copper-free channel, and its SW
// mouth opens into the corridor that leads straight to the west-seam taps.
// So each west-bound pad escapes INWARD onto its own depth lane (farther pad
// = deeper lane, so verticals never cross an earlier horizontal), rides the
// channel SW, and ends on a small tap pad freerouting can take over from.
// North PWMs (3,5,7,9) face the open west field: straight outward stubs.
// PWMA_78 (14) gets one outer lane around the NE tip into the east pocket.
// The SR pad itself is then suppressed from the router netlist (SR_STUBBED)
// -- the 0.5 mm fan discipline is constructed, not searched.
//
// Stubs are carried as keepouts like all constructed copper; quadroute trims
// the keepout (not the copper) back from each tap centre so the tap pad
// stays connectable -- the uncovered stub sliver is geometrically inside the
// pad's own clearance exclusion, so no foreign copper can legally touch it.
const TAP_DIA = 0.3;
const tailRuns = [];                             // kept empty; verifier iterates it
const fanTaps = [];
if (process.env.SR_SWEEP) {
  // SR_SWEEP: the fanout's pad-direction choices and lane depths encode the
  // COMMITTED placement's measured pocket (which pads are west-bound, the
  // bay-ring seal, the NE-tip clearance). A candidate register gets no stubs
  // -- every SR pad stays a plain router pin.
  writeFileSync(`${base}.srstub.json`, '[]');
} else {
  const sr = board.fps.find((f2) => f2.ref === `SR${centreQuad}`);
  const C = [sr.x, sr.y];
  // register frame from the pad geometry itself: u = row direction (pad 1 ->
  // 15), n = odd-to-even row normal; s/d coords are mm along/across.
  const pad = (nm) => {
    const p2 = sr.pads.find((q) => q.name === nm);
    return [sr.x + p2.dx, sr.y + p2.dy];
  };
  const [p1, p15] = [pad('1'), pad('15')];
  const u = [(p15[0] - p1[0]) / Math.hypot(p15[0] - p1[0], p15[1] - p1[1]),
             (p15[1] - p1[1]) / Math.hypot(p15[0] - p1[0], p15[1] - p1[1])];
  const oddC = [(p1[0] + p15[0]) / 2, (p1[1] + p15[1]) / 2];
  const dOdd = (oddC[0] - C[0]) * -u[1] + (oddC[1] - C[1]) * u[0];
  // n points from the centre line toward the EVEN row
  const n = dOdd > 0 ? [u[1], -u[0]] : [-u[1], u[0]];
  const at2 = (s2, d2) => [C[0] + s2 * u[0] + d2 * n[0], C[1] + s2 * u[1] + d2 * n[1]];
  const sd = ([x, y]) => [(x - C[0]) * u[0] + (y - C[1]) * u[1], (x - C[0]) * n[0] + (y - C[1]) * n[1]];
  const emit = (net, sdPts) => {
    const pts = sdPts.map(([s2, d2]) => at2(s2, d2)).map((p2) => p2.map((v) => +v.toFixed(3)));
    runs.push({ net, layer: PAD_LAYER, pts });
    // the A* constructions below must treat every stub as committed copper
    for (let i = 0; i + 1 < pts.length; i++) committed.push({ net, seg: [pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]] });
    const [ex, ey] = pts[pts.length - 1];
    fanTaps.push({ net, x: ex, y: ey, dia: TAP_DIA, kind: 'stub' });
  };
  const netOf = (nm) => {
    if (nm === '4') return 'VLOGIC_CW';          // the west half of VLOGIC's split job
    const bn = sr.pads.find((q) => q.name === nm).netName;
    return bn === 'VLOGIC' ? 'VLOGIC_CE' : bn === `DATA_${centreQuad}` ? 'DATA_W'
      : bn === `DATA_${centreQuad + 1}` ? 'DATA_E' : /^(GND|VBUS|SCLK|RCLK|OE_N|SDA|SCL)$/.test(bn) ? `${bn}_C` : bn;
  };
  // The bay ring sits essentially ON the register centre line (ring centre at
  // register-frame s 1.35, d -0.01), so the under-body channel is only clear
  // for s < 0.3: pad 4 (s -1.25) is the ONLY west-bound pad that can drop
  // into it. Pad 12's drop (s 0.75) is sealed below d 0.86 by two ring vias
  // (micron margins every way around -- measured, not guessed), and pads 10 /
  // 16 are equally cornered: those nets get internal-seam taps instead (see
  // the taps list). Pad 14 exits over the NE tip, deep enough (d 2.30) to
  // clear the VBUS via-link corner at (66.98, 66.95) by the pad rule.
  {
    const [s4] = sd(pad('4'));
    emit(netOf('4'), [[s4, 1.0], [s4, 0.30], [-2.10, 0.30]]);
    const [s14] = sd(pad('14'));
    emit(netOf('14'), [[s14, 1.4], [s14, 2.30], [1.85, 2.30]]);
  }
  // north PWMs: straight outward stubs into the open west field
  for (const nm of ['3', '5', '7', '9']) {
    const [s2] = sd(pad(nm));
    emit(netOf(nm), [[s2, -1.4], [s2, -2.50]]);
  }
  console.log(`fanout: ${fanTaps.length} stubs, taps at ${fanTaps.map((t) => t.net).join(',')}`);
  writeFileSync(`${base}.srstub.json`, JSON.stringify(['4', '14', '3', '5', '7', '9']));
  taps.push(...fanTaps);
}
const harnessFail = [];
const stubRuns = new Set();
{
  const sr = `SR${centreQuad}`;
  const rn = (net, from, to, opts) => { if (!routeNet(net, from, to, opts)) harnessFail.push(net); };
  // ESCAPE STUBS, BGA-fanout style: fifteen traces must enter the register
  // fan through two throats, and greedy one-at-a-time routing lets the first
  // arrivals wall the rest in (measured: everything after SCLK failed). So
  // every SR pad in play first gets a fixed stub straight out along its own
  // long axis, 0.29 mm past the fan's mutual-clearance bar; the A* then
  // routes tap<->stub-end and pad order stops mattering.
  const srFp = board.fps.find((f2) => f2.ref === sr);
  const stubEnd = new Map();                     // pad name -> [x, y]
  const stubFor = (net, name) => {
    const p2 = srFp.pads.find((q) => q.name === name);
    const a = (-((srFp.rot || 0) + (p2.ang || 0)) * Math.PI) / 180;   // y-down frame
    const u = [Math.cos(a), Math.sin(a)];
    const px = srFp.x + p2.dx, py = srFp.y + p2.dy;
    const outw = Math.sign((px - srFp.x) * u[0] + (py - srFp.y) * u[1]) || 1;
    // self-validate against statics AND committed foreign copper -- in the
    // generic-harness order the coil constructions precede the stubs, and a
    // stub stamped across a committed trunk is a verifier violation
    const fg = foreignFor(net);
    // a fixed-direction stub can land on a gutter via (DATA_E's
    // did, -0.084); try full length, then shorter, then give up and let the
    // A* leave from the pad itself
    for (const L of [1.1, 0.95]) {
      let ok2 = true;
      for (let s2 = 0.62; s2 <= L + 1e-9; s2 += 0.05) {
        const q = [px + outw * u[0] * s2, py + outw * u[1] * s2];
        const i2 = gi(toIx(q[0]), toIy(q[1]));
        if (blocked[i2] || fg[i2]) { ok2 = false; break; }
      }
      if (!ok2) continue;
      const e = [px + outw * u[0] * L, py + outw * u[1] * L];
      const r2 = { net, layer: PAD_LAYER, pts: [[+px.toFixed(3), +py.toFixed(3)], [+e[0].toFixed(3), +e[1].toFixed(3)]] };
      runs.push(r2); stubRuns.add(r2);
      committed.push({ net, seg: [px, py, e[0], e[1]] });
      stubEnd.set(name, e.map((v) => +v.toFixed(3)));
      return;
    }
    stubEnd.set(name, [px, py]);
  };
  const SR_NETS = [
    ['SCLK_C', '6'], ['RCLK_C', '8'], ['OE_N_C', '10'], ['DATA_W', '12'],
    ['DATA_E', '2'], ['GND_C', '1'], ['VLOGIC_C', '16'], ['VLOGIC_C', '4'],
    [`PWMB_${Q.cells[3]}`, '3'], [`PWMA_${Q.cells[3]}`, '5'],
    [`PWMB_${Q.cells[2]}`, '7'], [`PWMA_${Q.cells[2]}`, '9'],
    [`PWMB_${Q.cells[1]}`, '11'], [`PWMA_${Q.cells[1]}`, '13'],
    [`PWMB_${Q.cells[0]}`, '15'], [`PWMA_${Q.cells[0]}`, '14'],
  ];
  if (process.env.HARNESS_FULL) for (const [net, pad] of SR_NETS) stubFor(net, pad);
  // ESCAPE ENVELOPE: hard-block the whole pad field plus margin so stubs are
  // the ONLY way in -- an A* drop that legally hugs a pad row at 0.19 seals
  // every pad face it passes (measured: even a lone PWM became unroutable).
  // Stub ends (0.95-1.1 out) sit just outside the 0.3 margin (envelope edge
  // lands 0.7 from a pad centre along its long axis).
  const blockEnvelope = () => {
    let sx = 0, sy = 0;
    for (const p2 of srFp.pads) { sx += srFp.x + p2.dx; sy += srFp.y + p2.dy; }
    const cx2 = sx / srFp.pads.length, cy2 = sy / srFp.pads.length;
    const a = (-((srFp.rot || 0) + (srFp.pads[0].ang || 0)) * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    let maxL = 0, maxT = 0;
    for (const p2 of srFp.pads) {
      const dx = srFp.x + p2.dx - cx2, dy = srFp.y + p2.dy - cy2;
      maxL = Math.max(maxL, Math.abs(dx * ca + dy * sa) + p2.w / 2);
      maxT = Math.max(maxT, Math.abs(-dx * sa + dy * ca) + p2.h / 2);
    }
    blockRect({ x: cx2, y: cy2, w: 2 * maxL, h: 2 * maxT, rot: (-((srFp.rot || 0) + (srFp.pads[0].ang || 0))) }, 0.3, blocked);
  };
  if (process.env.HARNESS_FULL) blockEnvelope();
  // 1. coil hops -- CONSTRUCTION GATED OFF by default: A* paths hug the
  //    pockets at minimum clearance and, grown into keepouts, seal every
  //    U-pad approach (a byte-identical DSN scored 652 without the coil
  //    carry and 0.00 with it). freerouting routes them 8/8 as stage one.
  for (const ci of Q.cells) {
    if (process.env.HARNESS_FULL) {
      rn(`coil_${ci}_A`, padAt(`J${ci}.IN`, '1'), padAt(`U${ci}`, '2'));
      rn(`coil_${ci}_B`, padAt(`J${ci}.OUT`, '1'), padAt(`U${ci}`, '6'));
    } else {
      harnessFail.push(`coil_${ci}_A`, `coil_${ci}_B`);
    }
  }
  // The register fan needs a closed-form NESTED fanout (0.5 mm pitch at
  // 0.09/0.1 rules allows no same-layer crossing escapes; each side's 8
  // pads need distinct turn depths) -- until that generator exists the
  // whole pocket goes to the freerouting fallback in one negotiation.
  // HARNESS_FULL=1 re-enables the experimental A* fan construction.
  if (process.env.HARNESS_FULL) {
    // 2. register drops, from each net's tap barrel to its stub end
    const tapOf = (net) => taps.find((t) => t.net === net);
    const drops = [
      ['SCLK_C', '6'], ['RCLK_C', '8'], ['OE_N_C', '10'], ['DATA_W', '12'],
      ['DATA_E', '2'], ['GND_C', '1'], ['VLOGIC_C', '16'],
    ];
    for (const [net, pad] of drops) {
      const t = tapOf(net);
      rn(net, [t.x, t.y], stubEnd.get(pad), { startVia: t });
    }
    rn('VLOGIC_C', stubEnd.get('16'), stubEnd.get('4'));   // second VLOGIC pad, chained
    // 3. PWMs farthest-first: B.Cu-only A* reaches what it can; the rest go to
    //    the freerouting fallback stage, which can hop to the EMPTY inter-row
    //    In12 through gutter vias (the resource this constructor cannot use); the SR pad fan nests naturally that way
    const PWM_ORDER = [
      [`PWMB_${Q.cells[3]}`, '3', Q.cells[3], '5'], [`PWMA_${Q.cells[3]}`, '5', Q.cells[3], '1'],
      [`PWMB_${Q.cells[2]}`, '7', Q.cells[2], '5'], [`PWMA_${Q.cells[2]}`, '9', Q.cells[2], '1'],
      [`PWMB_${Q.cells[1]}`, '11', Q.cells[1], '5'], [`PWMA_${Q.cells[1]}`, '13', Q.cells[1], '1'],
      [`PWMB_${Q.cells[0]}`, '15', Q.cells[0], '5'], [`PWMA_${Q.cells[0]}`, '14', Q.cells[0], '1'],
    ];
    for (const [net, srPad, cell, uPad] of PWM_ORDER) {
      rn(net, stubEnd.get(srPad), padAt(`U${cell}`, uPad));
    }
  } else {
    for (const [net] of SR_NETS) if (!harnessFail.includes(net)) harnessFail.push(net);
    // VLOGIC's drop is two independent router jobs (see the taps comment).
    // In SR_SWEEP the pad-4 job keeps quadroute's name VLOGIC_C.
    const vi = harnessFail.indexOf('VLOGIC_C');
    if (vi >= 0) harnessFail.splice(vi, 1, ...(process.env.SR_SWEEP ? ['VLOGIC_C', 'VLOGIC_CE'] : ['VLOGIC_CW', 'VLOGIC_CE']));
  }
  // --- A*-constructed paths for the DETERMINISTIC freerouting failures ------
  // Measured across four pipeline runs (2026-07-30): freerouting gives up
  // instantly (zero fragments, "cannot make further progress") on every net
  // whose corridor is a single thread -- the register cell's coil_78_B, the
  // long PWMs, GND's drop once the stub comb walls the west field. B.Cu-only
  // paths exist for all of them (winding never blocks B.Cu; only pads,
  // barrels and constructed copper do), so they are CONSTRUCTED here in
  // dependency order: short critical-corridor links first so later paths
  // nest around them, then the slot/thread contenders in the order that
  // assigns each its only-choice lane, then the four north PWMs whose band
  // weave has the most freedom. A failure leaves the net in the freerouting
  // fallback exactly like every other harness miss.
  if (!process.env.HARNESS_FULL) {
    const tapOf2 = (net) => taps.find((t) => t.net === net && t.kind !== 'stub');
    const stubEndOf = (net) => {
      const t = fanTaps.find((t2) => t2.net === net);
      return t ? [t.x, t.y] : null;
    };
    const built = [];
    const con = (net, from, to, opts) => {
      if (routeNet(net, from, to, opts)) built.push(net);
      else if (!harnessFail.includes(net)) harnessFail.push(net);
    };
    const O = [c78x - 64.99, c78y - 66.529];     // cell-78 frame offset
    const gd = (pts) => pts.map(([x, y]) => [x + O[0], y + O[1]]);
    // 0. coil_78_A first of all: its 1.6 mm hop runs mostly through its own
    // pads' clearance zones, but the harness lanes threading past it left
    // freerouting only 0.2-0.3 mm weaves it refuses (R1 regression measured
    // 2026-07-30); constructed first, everything else nests around it.
    con(`coil_${Q.cells[0]}_A`, padAt(`J${Q.cells[0]}.IN`, '1'), padAt(`U${Q.cells[0]}`, '2'));
    // coil_90_B: freerouting refuses the 0.13 mm thread between cell 90's
    // ring-east via and C90.1 once the harness hems its start; constructed
    // through the measured window
    con(`coil_${Q.cells[2]}_B`, padAt(`J${Q.cells[2]}.OUT`, '1'), padAt(`U${Q.cells[2]}`, '6'), {
      guide: gd([[70.95, 62.56], [70.5, 61.9], [70.15, 61.0], [70.0, 60.2], [70.15, 59.6],
        [70.37, 59.15], [70.37, 58.7], [70.3, 57.75], [69.62, 57.75]]),
    });
    // coil_91_B: the mirrored window (0.11 mm past ring-91-east / C91.1),
    // further hemmed by PWMB_91's pocket vertical
    con(`coil_${Q.cells[3]}_B`, padAt(`J${Q.cells[3]}.OUT`, '1'), padAt(`U${Q.cells[3]}`, '6'), {
      guide: gd([[79.42, 62.56], [78.97, 61.9], [78.62, 61.0], [78.47, 60.2], [78.62, 59.6],
        [78.84, 59.15], [78.84, 58.7], [78.77, 57.75], [78.08, 57.75]]),
    });
    // 1-2. the west field's own users, before the north verticals wall it
    // (SR_SWEEP: both are register drops measured against the committed spot
    // -- a candidate register leaves them to the router)
    if (!process.env.SR_SWEEP) {
      const g2 = tapOf2('GND_C');
      con('GND_C', [g2.x, g2.y], padAt(sr, '1'), { startVia: g2 });
      const v2 = tapOf2('VLOGIC_CW');
      con('VLOGIC_CW', [v2.x, v2.y], stubEndOf('VLOGIC_CW'), { startVia: v2 });
    }
    // 3-5. the register cell's trio, in natural-shortest-disjoint order
    // (measured on fanout.conmap.png): PWMB_78 west-approaches the inter-
    // column slot, PWMA_78 takes the east thread between the GND riser and
    // the A-column, and coil_78_B -- whose greedy east choice would cross
    // both -- then west-loops to the slot's other lane. Pair rule everywhere
    // else: the FARTHER pad (A, top row) constructs first, so the sibling
    // weaves around committed copper instead of being walled in (PWMB_91's
    // greedy wall killed PWMA_91/PWMB_90/PWMA_90 when B went first).
    // Guides are the corridors measured on fanout.pocket/conmap.png, in board
    // coordinates for THIS quad; they generalise because every quad is the
    // same stamp. Soft preference only -- legality still comes from the
    // raster + the exact verifier.
    // PWMB_78 is NOT constructed: pad 15's descent and coil_78_B's pocket
    // approach inherently cross in the N-tip channel, and of the two only
    // the coil is freerouting-hopeless (PWMB_78 completed 3 of 4 router
    // runs; with the slot left free its odds are good).
    // PWMA_78 BEFORE the coil tail: its pocket descent (x 69.93) and the
    // tail's flank descent share cell 79's west flank at 0.22 apart -- under
    // the A*'s safe threshold. Tail-first forced PWMA_78 into a south-margin
    // + x 70.23 seam-wall hook that sealed EVERY R2 pocket escape (R2 went
    // 10/10 unrouted, score 0.00, instantly). PWMA_78 first on its measured
    // corridor (guide pins it against grid-tie-break chaos), then the tail
    // threads east of it at x ~70.30.
    if (!process.env.SR_SWEEP) con(`PWMA_${Q.cells[0]}`, stubEndOf(`PWMA_${Q.cells[0]}`), padAt(`U${Q.cells[0]}`, '1'), {
      guide: gd([[66.11, 67.35], [66.89, 67.80], [67.19, 67.28], [68.68, 67.28], [69.08, 67.38],
        [69.93, 66.53], [69.93, 64.70], [68.73, 63.50], [67.91, 63.50], [67.58, 63.18]]),
    });
    // coil_78_B's B.Cu tail: starts at the constructed In12-dogleg via in the
    // SE gutter (see the dogleg block above -- the SW terminal itself is
    // unreachable on B.Cu without evicting the west field's constructions),
    // which sits where the OLD east-around corridor began. Guide is the
    // measured original with the flank descent biased east (70.15 -> 70.30)
    // to clear PWMA_78's committed 69.93 line: east-around the internal seam,
    // seam crossing at y~69.8 (the DATA portal seals the 68.5 gap), band
    // return north of the 63.2 barrels, mini-gate west, U78.6's WEST face
    // from the flank pocket (the slot belongs to PWMB_78); the west return
    // dips through the mini-gate past (65.27,61.72), rounds the J78.IN blob
    // on its north, and takes the SERPENTINE down to the flank pocket --
    // coil_78_A's constructed hop walls the direct gate descent.
    const tailGuide = gd([[67.60, 69.60], [67.6, 69.35], [68.5, 69.25], [69.3, 69.8], [69.85, 69.55], [70.25, 68.8],
      [70.30, 67.0], [70.30, 65.0], [69.95, 64.1], [69.35, 63.35], [68.9, 62.75], [68.5, 62.0],
      [66.0, 62.0], [65.6, 62.2], [64.87, 62.25], [64.6, 61.95], [64.1, 61.9], [63.7, 62.0],
      [63.2, 62.4], [63.0, 62.95], [63.15, 63.35], [63.6, 63.7], [64.05, 63.95], [64.4, 64.3],
      [64.5, 64.9], [64.94, 65.08], [65.38, 65.08]]);
    if (!process.env.SR_SWEEP) {
      con(`coil_${Q.cells[0]}_B`, [coilViaSW.x, coilViaSW.y], padAt(`U${Q.cells[0]}`, '6'), {
        startVia: coilViaSW,
        guide: tailGuide,
      });
    } else {
      // SR_SWEEP: a candidate register may leave the SW terminal's west field
      // open -- try the direct B.Cu trunk first (denying the A-half's pads:
      // the halves are ONE KiCad net, so nothing downstream would see the
      // short), then the committed dogleg + tail, else withdraw the dogleg
      // entirely -- a carried In12 leg with no tail would keep out its own
      // net's J.OUT pin in the router stages.
      const cn = `coil_${Q.cells[0]}_B`;
      const deny = [[`J${Q.cells[0]}.IN`, '1'], [`U${Q.cells[0]}`, '2']];
      con(cn, padAt(`J${Q.cells[0]}.OUT`, '1'), padAt(`U${Q.cells[0]}`, '6'), { denyPads: deny });
      if (!built.includes(cn)) {
        coilViaSW.emitLeg();
        con(cn, [coilViaSW.x, coilViaSW.y], padAt(`U${Q.cells[0]}`, '6'), { startVia: coilViaSW, guide: tailGuide, denyPads: deny });
        if (!built.includes(cn)) {
          for (let i2 = runs.length - 1; i2 >= 0; i2--) if (runs[i2].net === cn) runs.splice(i2, 1);
          for (let i2 = cvias.length - 1; i2 >= 0; i2--) if (cvias[i2].net === cn) cvias.splice(i2, 1);
        }
      }
    }
    if (process.env.SR_SWEEP) {
      // The REGISTER CELL's own _B coil is the router-hopeless net wherever
      // the register sits (measured: cell 78 at the committed spot; cell 79
      // in the SE pocket, where round-1 R1 lost it at every SE candidate).
      // Construct it direct-first there too -- before the stubs and pocket
      // work, coils-first like everything else.
      const srF2 = board.fps.find((f2) => f2.ref === `SR${centreQuad}`);
      let regCell = Q.cells[0], regD = 1e9;
      for (const ci of Q.cells) {
        const d = Math.hypot(coils[ci][0] - srF2.x, coils[ci][1] - srF2.y);
        if (d < regD) { regD = d; regCell = ci; }
      }
      if (regCell !== Q.cells[0]) {
        const cn2 = `coil_${regCell}_B`;
        con(cn2, padAt(`J${regCell}.OUT`, '1'), padAt(`U${regCell}`, '6'),
          { denyPads: [[`J${regCell}.IN`, '1'], [`U${regCell}`, '2']] });
      }
    }
    if (process.env.SR_SWEEP && process.env.SR_CONSTRUCT) {
      // GENERIC parametric harness for a candidate register: stubs on every
      // SR pad (stubFor reads the pad geometry, placement-agnostic), the
      // escape envelope, A* drops from each control net's tap barrel to its
      // stub end, then the PWMs farthest-first -- the measured-guide harness
      // minus the guides. What constructs here is exactly the candidate's
      // own geometry, which is the quantity the sweep ranks.
      const GEN_NETS = SR_NETS.map(([net, pad]) => (pad === '16' ? ['VLOGIC_CE', pad] : [net, pad]));
      for (const [net, pad] of GEN_NETS) stubFor(net, pad);
      blockEnvelope();
      const hasStub = (pad) => {
        const e = stubEnd.get(pad);
        const p2 = srFp.pads.find((q) => q.name === pad);
        return Math.hypot(e[0] - (srFp.x + p2.dx), e[1] - (srFp.y + p2.dy)) > 0.5;
      };
      for (const [net, pad] of [['SCLK_C', '6'], ['RCLK_C', '8'], ['OE_N_C', '10'], ['DATA_W', '12'],
        ['DATA_E', '2'], ['GND_C', '1'], ['VLOGIC_C', '4'], ['VLOGIC_CE', '16']]) {
        const t = taps.find((t2) => t2.net === net && t2.kind !== 'stub');
        con(net, [t.x, t.y], stubEnd.get(pad), { startVia: t });
      }
      for (const [net, srPad, cell, uPad] of [
        [`PWMB_${Q.cells[3]}`, '3', Q.cells[3], '5'], [`PWMA_${Q.cells[3]}`, '5', Q.cells[3], '1'],
        [`PWMB_${Q.cells[2]}`, '7', Q.cells[2], '5'], [`PWMA_${Q.cells[2]}`, '9', Q.cells[2], '1'],
        [`PWMB_${Q.cells[1]}`, '11', Q.cells[1], '5'], [`PWMA_${Q.cells[1]}`, '13', Q.cells[1], '1'],
        [`PWMB_${Q.cells[0]}`, '15', Q.cells[0], '5'], [`PWMA_${Q.cells[0]}`, '14', Q.cells[0], '1'],
      ]) {
        con(net, stubEnd.get(srPad), padAt(`U${cell}`, uPad));
      }
      // unbuilt-but-stubbed nets hand the router the stub-end tap pad; their
      // SR pads leave the netlist (srstub) exactly like the measured fanout's
      for (const [net, pad] of GEN_NETS) {
        if (hasStub(pad)) fanTaps.push({ net, x: stubEnd.get(pad)[0], y: stubEnd.get(pad)[1], dia: TAP_DIA, kind: 'stub' });
      }
      taps.push(...fanTaps);
      writeFileSync(`${base}.srstub.json`, JSON.stringify(GEN_NETS.filter(([, pad]) => hasStub(pad)).map(([, pad]) => pad)));
      // an unbuilt net's STUB must still emit -- its stub-end tap is the
      // router's pin here (measured-fanout semantics, unlike HARNESS_FULL
      // whose failures revert to the bare pad and drop the stub)
      for (const r of [...stubRuns]) if (!built.includes(r.net)) stubRuns.delete(r);
    }
    // 6-7. cell 79's pair, PINNED to the corridors the A* actually took on
    // the accepted 13:54 board (the old hand guides described different
    // lanes and the A* deviated; after the dogleg changed grid tie-breaks,
    // unpinned runs drifted onto PWMA_91's wedge vertical and starved it).
    // A: SR.13 south-west descent, the x 66.11 vertical, row-3 margin east,
    // then down into U79.1 from the north-east.
    if (!process.env.SR_SWEEP) con(`PWMA_${Q.cells[1]}`, padAt(sr, '13'), padAt(`U${Q.cells[1]}`, '1'), {
      guide: gd([[63.68, 65.95], [63.31, 65.50], [63.56, 65.08], [63.56, 64.65], [64.23, 63.98],
        [64.61, 63.48], [64.78, 63.65], [65.96, 63.65], [66.11, 63.50], [66.11, 59.25],
        [69.01, 56.35], [73.13, 56.35], [74.58, 57.80], [74.58, 62.25], [75.28, 62.95],
        [75.81, 62.95], [76.03, 63.18]]),
    });
    // B: its own x 62.68 vertical (NOT the 61.68 wedge -- that is PWMA_91's),
    // row-crossing at x 64.28, the row-3 margin all the way east past cell
    // 91, then back south-west into U79.5.
    if (!process.env.SR_SWEEP) con(`PWMB_${Q.cells[1]}`, padAt(sr, '11'), padAt(`U${Q.cells[1]}`, '5'), {
      guide: gd([[63.43, 66.38], [62.68, 65.58], [62.68, 63.00], [64.28, 61.40], [64.28, 59.08],
        [66.91, 56.45], [66.91, 55.78], [68.08, 54.60], [69.36, 54.80], [70.73, 54.18],
        [73.01, 54.23], [75.13, 56.35], [81.61, 56.35], [82.63, 57.38], [82.63, 61.03],
        [82.36, 61.30], [79.18, 61.30], [76.81, 63.68], [75.43, 63.70], [75.43, 64.65],
        [75.86, 65.08], [76.03, 65.08]]),
    });
    // 8-11. north PWMs. B_91 owns the only clear south descent (the SW-most
    // stub crosses nothing); A_91 hops NE over the comb and takes the
    // serpentine; both cross the row-2 seam ladders through the measured
    // Z-windows (A column y 58.3-59.2, B column y 59.2-60.5) and the U-column
    // gaps. The 90 pair runs unguided last: mini-gate and leftovers, with the
    // freerouting fallback (which completed PWMA_90 tonight) as the net.
    // B_91 first: its start sits in the wedge between the ladder and the
    // GND/VLOGIC_CW diagonals and gets boxed in by any later commit
    // B_91 crosses to cell 91 along the ROW-3 MARGIN band (y ~54.9), not
    // through cell 90's field: any full-width E-W lane through that field
    // orphans coil_90_B on both layers (measured R1 regression). Up cell
    // 90's west flank, over the row-3 J.OUT / J90.IN blob gap, east, then
    // down into cell 91's pocket.
    if (!process.env.SR_SWEEP) con(`PWMB_${Q.cells[3]}`, stubEndOf(`PWMB_${Q.cells[3]}`), padAt(`U${Q.cells[3]}`, '5'), {
      guide: gd([[61.49, 67.56], [61.55, 66.9], [61.75, 66.35], [62.0, 65.8], [62.05, 64.6], [62.05, 63.35],
        [62.4, 62.6], [62.75, 61.5], [63.5, 60.85], [64.15, 59.3], [64.5, 58.85], [65.05, 59.2],
        [65.6, 59.7], [65.85, 59.0], [65.9, 57.5], [66.0, 56.2], [66.4, 55.4], [67.0, 54.9],
        [68.0, 54.85], [70.0, 54.85], [72.0, 54.85], [74.0, 54.8], [74.6, 54.7], [75.8, 54.7],
        [76.6, 54.85], [77.3, 55.0], [77.5, 55.33], [78.6, 55.3], [79.15, 55.4], [79.15, 57.5],
        [79.6, 57.75], [79.9, 57.75]]),
    });
    if (!process.env.SR_SWEEP) con(`PWMA_${Q.cells[3]}`, stubEndOf(`PWMA_${Q.cells[3]}`), padAt(`U${Q.cells[3]}`, '1'), {
      guide: gd([[61.74, 67.13], [62.5, 66.2], [63.1, 65.7], [63.35, 64.9], [63.1, 63.35], [63.35, 62.75],
        [63.9, 61.6], [64.15, 59.4], [64.4, 58.9], [65.0, 59.15], [65.6, 59.7], [66.3, 60.1],
        [68.5, 60.2], [70.5, 60.1], [72.5, 59.9], [72.9, 58.8], [73.45, 59.1], [74.05, 59.75],
        [75.0, 58.5], [76.2, 57.2], [77.3, 56.5], [78.1, 56.33], [79.0, 56.33], [79.45, 56.1], [79.45, 55.85], [80.28, 55.85]]),
    });
    // A_90 takes the one west window past the tri-lobe (x 61.80-62.06), the
    // Z-crossing, and cell 90's field to the U-column gap. B_90 has no
    // remaining constructible corridor (gate: coil's; serpentine: A_91's;
    // west window: A_90's) -- unguided attempt, freerouting fallback likely,
    // and the router can via-hop to In12 which this constructor cannot.
    if (!process.env.SR_SWEEP) con(`PWMA_${Q.cells[2]}`, stubEndOf(`PWMA_${Q.cells[2]}`), padAt(`U${Q.cells[2]}`, '1'), {
      guide: gd([[62.24, 66.27], [62.3, 65.4], [62.3, 64.4], [62.05, 63.6], [62.1, 62.7], [62.7, 61.9],
        [63.3, 61.2], [63.95, 60.4], [64.25, 59.5], [64.5, 59.0], [65.05, 59.25], [65.6, 59.6],
        [66.6, 58.9], [67.5, 58.2], [68.2, 57.2], [68.85, 56.5], [69.1, 56.34], [70.2, 56.33],
        [70.85, 56.1], [70.85, 55.85], [71.42, 55.85]]),
    });
    if (!process.env.SR_SWEEP) con(`PWMB_${Q.cells[2]}`, stubEndOf(`PWMB_${Q.cells[2]}`), padAt(`U${Q.cells[2]}`, '5'));
    console.log(`constructed paths: ${built.join(',') || 'none'}`);
    // constructed nets leave the router problem entirely: no fallback entry,
    // no tap pins (their copper is pure keepout downstream), and their SR
    // pads join SR_STUBBED via srstub.json below.
    for (const net of built) {
      let i2;
      while ((i2 = harnessFail.indexOf(net)) >= 0) harnessFail.splice(i2, 1);
    }
    const builtSet = new Set(built);
    for (let i2 = fanTaps.length - 1; i2 >= 0; i2--) if (builtSet.has(fanTaps[i2].net)) fanTaps.splice(i2, 1);
    for (let i2 = taps.length - 1; i2 >= 0; i2--) if (builtSet.has(taps[i2].net)) taps.splice(i2, 1);
    const extraStub = [];
    if (builtSet.has('GND_C')) extraStub.push('1');
    if (builtSet.has(`PWMB_${Q.cells[1]}`)) extraStub.push('11');
    if (builtSet.has(`PWMA_${Q.cells[1]}`)) extraStub.push('13');
    if (builtSet.has(`PWMB_${Q.cells[0]}`)) extraStub.push('15');
    const cur = JSON.parse(readFileSync(`${base}.srstub.json`, 'utf8'));
    writeFileSync(`${base}.srstub.json`, JSON.stringify([...cur, ...extraStub]));
  }
  if (harnessFail.length) console.error(`HARNESS incomplete (freerouting fallback takes these): ${harnessFail.join(',')}`);
  else console.log('harness: 8 coils + 7 drops + 8 PWMs all constructed');
  writeFileSync(`${base}.todo.json`, JSON.stringify([...new Set(harnessFail)]));
}

// --- numeric verification ------------------------------------------------------
const ptSeg = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
  const t = L > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};
// distance from a segment to a rotated rectangle (pad), centre (cx,cy),
// size w x h, angle deg. Sampled: rect corner/edge points against the
// segment plus segment endpoints against the rect -- exact enough at trace
// scale, and errs conservative with the 16-point edge sampling.
const rectPts = (p2) => {
  const a = (p2.ang * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const out = [];
  for (let i = 0; i <= 8; i++) {
    for (const s of [-1, 1]) {
      const lx = (i / 8 - 0.5) * p2.w, ly = (s * p2.h) / 2;
      out.push([p2.cx + lx * ca - ly * sa, p2.cy + lx * sa + ly * ca]);
      const lx2 = (s * p2.w) / 2, ly2 = (i / 8 - 0.5) * p2.h;
      out.push([p2.cx + lx2 * ca - ly2 * sa, p2.cy + lx2 * sa + ly2 * ca]);
    }
  }
  return out;
};
const segRect = (seg, p2) => {
  let d = Infinity;
  for (const [qx, qy] of rectPts(p2)) d = Math.min(d, ptSeg(qx, qy, ...seg));
  return d;
};
const segs = [];                                 // flattened {net, layer, seg:[ax,ay,bx,by]}
for (const r of [...runs, ...tailRuns]) {
  for (let i = 0; i + 1 < r.pts.length; i++) {
    segs.push({ net: r.net, layer: r.layer, seg: [r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]] });
  }
}
const baseName = boardName;
const pads = [];
for (const fp of board.fps) {
  for (const p2 of fp.pads) {
    pads.push({ cx: fp.x + p2.dx, cy: fp.y + p2.dy, w: p2.w, h: p2.h, ang: -((fp.rot || 0) + (p2.ang || 0)), net: p2.netName, ref: `${fp.ref}.${p2.name}` });
  }
}
let bad = 0;
let minVia = 1e9, minPad = 1e9, minXNet = 1e9;
for (const s of segs) {
  const own = anchors.get(s.net) || [];
  const ownPads = padsByNet.get(boardName(s.net)) || [];
  const ownVia = (x, y) => own.some((a) => Math.hypot(a.x - x, a.y - y) < 0.02)
    || cvias.some((v) => v.net === s.net && Math.hypot(v.x - x, v.y - y) < 0.02)
    || ownBarrels.some((b) => b.net === s.net && Math.hypot(b.x - x, b.y - y) < 0.02)
    || ownPads.some((g2) => inPad(x, y, g2));    // coil terminal barrels live under their J pads
  // through-via barrels are copper on BOTH constructed layers
  for (const v of board.vias) {
    if (ownVia(v.x, v.y)) continue;
    const need = v.size / 2 + CLR + W / 2;
    const d = ptSeg(v.x, v.y, ...s.seg) - need;
    if (ptSeg(v.x, v.y, ...s.seg) < 3) minVia = Math.min(minVia, d);
    if (d < -1e-9) { console.error(`VIOLATION ${s.net} ${s.layer} vs via at ${v.x.toFixed(2)},${v.y.toFixed(2)}: ${d.toFixed(3)}`); bad++; }
  }
  // pads live on B.Cu only; same-base-net pads may be touched (that is the tooth)
  if (s.layer === PAD_LAYER) {
    for (const p2 of pads) {
      if (p2.net === baseName(s.net)) continue;
      const d = segRect(s.seg, p2) - (CLR + W / 2);
      if (segRect(s.seg, p2) < 2) minPad = Math.min(minPad, d);
      if (d < -1e-9) { console.error(`VIOLATION ${s.net} B.Cu seg (${s.seg.map((q) => q.toFixed(2)).join(',')}) vs pad ${p2.ref} [${p2.net}] at ${p2.cx.toFixed(2)},${p2.cy.toFixed(2)}: ${d.toFixed(3)}`); bad++; }
    }
  }
  // constructed portal vias of other nets
  for (const v of cvias) {
    if (v.net === s.net) continue;
    const d = ptSeg(v.x, v.y, ...s.seg) - (0.25 + CLR + W / 2);
    if (d < -1e-9) { console.error(`VIOLATION ${s.net} vs ${v.net} portal via: ${d.toFixed(3)}`); bad++; }
  }
}
// constructed vs constructed, per layer, different nets
for (let i = 0; i < segs.length; i++) {
  for (let j = i + 1; j < segs.length; j++) {
    const a = segs[i], b = segs[j];
    if (a.net === b.net || a.layer !== b.layer) continue;
    const d = Math.min(
      ptSeg(a.seg[0], a.seg[1], ...b.seg), ptSeg(a.seg[2], a.seg[3], ...b.seg),
      ptSeg(b.seg[0], b.seg[1], ...a.seg), ptSeg(b.seg[2], b.seg[3], ...a.seg),
    ) - (W + CLR);
    minXNet = Math.min(minXNet, d + W + CLR);
    if (d < -1e-9) { console.error(`VIOLATION ${a.net} x ${b.net} on ${a.layer}: gap ${(d + W + CLR).toFixed(3)}`); bad++; }
  }
}
// every anchor of a constructed net must touch its copper
for (const [net, as] of anchors) {
  if (![...LANES, ...POWER].includes(net)) continue;
  const rows = new Map();
  for (const a of as) { const k = rowKey(a.y); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(a); }
  for (const [, group] of rows) {
    if (group.length < 2 && !POWER.includes(net) && net !== 'DATA_E') continue;
    for (const a of group) {
      const hit = segs.some((s) => s.net === net && ptSeg(a.x, a.y, ...s.seg) < 0.05);
      if (!hit) { console.error(`VIOLATION ${net} anchor ${a.x.toFixed(2)},${a.y.toFixed(2)} not on its copper`); bad++; }
    }
  }
}
// every power pad must be touched by a same-net B.Cu tooth
for (const p2 of pads) {
  if (!['VBUS', 'GND'].includes(p2.net)) continue;
  if (!/^(U|C)\d+\./.test(p2.ref)) continue;     // SR.1 is the routed drop
  const cell = +p2.ref.match(/\d+/)[0];
  if (!inQuad.has(cell)) continue;
  const hit = segs.some((s) => s.layer === PAD_LAYER && baseName(s.net) === p2.net && segRect(s.seg, { ...p2 }) < W / 2 + 0.01);
  if (!hit) { console.error(`VIOLATION power pad ${p2.ref} not toothed`); bad++; }
}
console.log(`runs ${runs.length} (${segs.length} segments), constructed vias ${cvias.length}, taps ${taps.length}`);
console.log(`min margins: via ${minVia.toFixed(3)}, pad ${minPad.toFixed(3)}, cross-net gap ${minXNet.toFixed(3)}`);
if (bad) { console.error(`${bad} violations -- NOT writing output`); process.exit(1); }

// --- emit ----------------------------------------------------------------------
const U = (mm) => Math.round(mm * 10000);        // resolution um 10 = 0.1 um units
const failSet = new Set(harnessFail);
const byNet = new Map();
for (const r of runs) {
  if (stubRuns.has(r) && failSet.has(r.net)) continue;
  if (!byNet.has(r.net)) byNet.set(r.net, { wires: [], vias: [] });
  byNet.get(r.net).wires.push(r);
}
for (const v of cvias) {
  if (!byNet.has(v.net)) byNet.set(v.net, { wires: [], vias: [] });
  byNet.get(v.net).vias.push(v);
}
let s = `(session ${base}\n  (base_design ${base})\n  (placement\n    (resolution um 10)\n  )\n  (was_is\n  )\n  (routes \n    (resolution um 10)\n    (parser\n      (host_cad "lanegen.mjs")\n    )\n    (library_out \n    )\n    (network_out \n`;
for (const [net, g] of byNet) {
  s += `      (net ${net}\n`;
  for (const w of g.wires) {
    s += `        (wire\n          (path ${w.layer} ${U(W)} ${w.pts.map(([x, y]) => `${U(x)} ${U(-y)}`).join('  ')}\n          )\n        )\n`;
  }
  for (const v of g.vias) s += `        (via "Via_route" ${U(v.x)} ${U(-v.y)}\n        )\n`;
  s += `      )\n`;
}
s += `    )\n  )\n)\n`;
writeFileSync(outSes, s);
writeFileSync(`${base}.taps.json`, JSON.stringify(taps, null, 1));
// anchor pins for debugging with checkses. NOTE the expected verdict: each
// two-row lane (and each power net) reports SPLIT into exactly its two row
// groups -- rows join at the board-margin spines, not inside the stamp. The
// authoritative check on the construction is the numeric verifier above.
{
  const pins = [];
  for (const [net, as] of anchors) {
    if (![...LANES, ...POWER].includes(net)) continue;
    for (const a of as) pins.push({ net, x: a.x, y: a.y, label: `A@${a.x.toFixed(1)},${a.y.toFixed(1)}`, w: 0.5, h: 0.5 });
  }
  writeFileSync(`${base}.lanepins.json`, JSON.stringify(pins, null, 1));
}
console.log(`wrote ${outSes}, ${base}.taps.json, ${base}.lanepins.json`);
