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
import { FAB, pcbCoilGeometry, viaPlan, viaSize } from '../src/kicad.js';
import { readBoard } from './mkdsn.mjs';
import { SEAM_SIGNALS, FABRIC_HUG_X } from './cellspec.mjs';

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
// Winding-layer routing FABRIC (task 15): extra construction layers opened
// through the seam gutters. banFlats keeps the E/W flats free of vias AND
// tabs on every winding layer, so a vertical seam gutter is a clean channel
// there; one lane per ladder column per layer (jogs decouple by layer).
const FABRIC = (process.env.FABRIC_LAYERS || '').split(',').filter(Boolean);
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

// Coil terminals are their THROUGH-VIAS now (the Term SMT pads are gone --
// they only ate B.Cu next to the pockets). Locate them from the same via
// plan the board was built with; termVias[0] = IN lead (-> coil_i_A),
// termVias[1] = OUT (-> coil_i_B). Plan coords are file-frame cell offsets.
const gPlan = pcbCoilGeometry(cfg);
const cellHalfP = (cfg.stator.coilPitch * 1000) / 2;
const planT = viaPlan(gPlan, gPlan.layers, cellHalfP, viaSize(gPlan, cellHalfP), spec.viaPlanOpts || {});
const termViaAt = (ci, which) => {
  const tv = planT.termVias[which === 'IN' ? 0 : 1];
  const [ccx, ccy] = coils[ci];
  const bx = ccx + tv.p[0], by = ccy + tv.p[1];
  const bv = board.vias.find((v) => Math.hypot(v.x - bx, v.y - by) < 0.05);
  if (!bv) { console.error(`termViaAt: no board via at ${which} terminal of cell ${ci} (${bx.toFixed(3)},${by.toFixed(3)})`); process.exit(1); }
  return [bv.x, bv.y];
};
// Fabric obstacle model: on a winding layer the copper is the winding hex
// annulus plus that layer's crossover/terminal TABS. Tab segments per layer
// (board frame) and the hex edges per coil, for the verifier and via-site
// probes. Winding index j names layer 'In<j>.Cu' (j=0 would be F.Cu; the
// fabric never uses it).
const coilKeepRG = gPlan.halfOut + gPlan.trace / 2;
const fabricTabs = new Map(FABRIC.map((ln) => [ln, []]));
const allTabs = [];                              // every layer's tabs: via-site probes care about all of them
{
  const nameOfIdx = (j) => (j === 0 ? 'F.Cu' : `In${j}.Cu`);
  for (const [ccx, ccy] of coils) {
    for (const t2 of [...planT.segments, ...planT.terminals]) {
      const seg = [ccx + t2[0], ccy + t2[1], ccx + t2[2], ccy + t2[3]];
      allTabs.push(seg);
      const ln = nameOfIdx(t2[4]);
      if (fabricTabs.has(ln)) fabricTabs.get(ln).push(seg);
    }
  }
}
const hexDistG = (dx, dy) => {
  let m = -Infinity;
  for (let k2 = 0; k2 < 6; k2++) {
    const a2 = (k2 * Math.PI) / 3;
    m = Math.max(m, dx * Math.cos(a2) + dy * Math.sin(a2));
  }
  return m;
};
// hexagon boundary edges (at the winding's copper edge) per coil, for exact
// segment-vs-winding clearance on fabric layers
const hexEdges = [];
for (const [ccx, ccy] of coils) {
  const R2 = coilKeepRG / Math.cos(Math.PI / 6);
  for (let k2 = 0; k2 < 6; k2++) {
    const a1 = (k2 * Math.PI) / 3 + Math.PI / 6, a2 = ((k2 + 1) * Math.PI) / 3 + Math.PI / 6;
    hexEdges.push([ccx + R2 * Math.cos(a1), ccy + R2 * Math.sin(a1), ccx + R2 * Math.cos(a2), ccy + R2 * Math.sin(a2), ccx, ccy]);
  }
}
const segSegD = (a, b) => {
  const d1 = [a[2] - a[0], a[3] - a[1]], d2 = [b[2] - b[0], b[3] - b[1]];
  const r2 = [a[0] - b[0], a[1] - b[1]];
  const A = d1[0] * d1[0] + d1[1] * d1[1], E = d2[0] * d2[0] + d2[1] * d2[1];
  const F = d2[0] * r2[0] + d2[1] * r2[1];
  let s2 = 0, t2 = 0;
  if (A > 1e-12) {
    const C = d1[0] * r2[0] + d1[1] * r2[1];
    if (E > 1e-12) {
      const B = d1[0] * d2[0] + d1[1] * d2[1];
      const den = A * E - B * B;
      s2 = den > 1e-12 ? Math.max(0, Math.min(1, (B * F - C * E) / den)) : 0;
      t2 = Math.max(0, Math.min(1, (B * s2 + F) / E));
      s2 = Math.max(0, Math.min(1, (B * t2 - C) / A));
    } else s2 = Math.max(0, Math.min(1, -C / A));
  } else if (E > 1e-12) t2 = Math.max(0, Math.min(1, F / E));
  const px2 = a[0] + d1[0] * s2 - (b[0] + d2[0] * t2), py2 = a[1] + d1[1] * s2 - (b[1] + d2[1] * t2);
  return Math.hypot(px2, py2);
};

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
      // unused DATA slot of the quad-internal seam. The portal has no board
      // via to snap to, so its position derives from the SNAPPED SCLK anchor
      // on the same seam (quadgen's seam frame is a few hundredths off the
      // cellspec offsets; an off-column portal blocks the fabric hug lane).
      let [px, py] = at('DATA');
      const sclkInt = (anchors.get('SCLK_C') || []).find((a) => Math.abs(a.x - px) < 0.3 && Math.abs(a.y - y) < 1.5);
      if (sclkInt) { px = sclkInt.x; py = sclkInt.y + (off.SCLK[1] - off.DATA[1]); }
      if (Math.abs(py - y) > 0.01) { console.error(`DATA_E portal y mismatch ${py} vs ${y}`); process.exit(1); }
      x0 = Math.min(x0, px);
      cvias.push({ net, x: +px.toFixed(4), y: +py.toFixed(4) });
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
    trunk: [[-4.644, -0.424], [-1.30, -0.424], [-1.30, -1.05], [1.30, -1.05], [1.30, -0.424], [3.823, -0.424]],
    teeth: [
      [[1.10, 0.596], [1.10, 2.396], [0.75, 2.396]],    // riser past U.6, into U.4
      [[1.10, 0.596], [1.50, 0.596]],                    // into C.1
      [[1.79, 0.596], [1.993, 0.596], [1.993, -0.424], [3.823, -0.424]],  // C.1 east -> own seam via
    ],
    teethReg: null,
  },
  GND_C: {
    trunk: [[-4.074, 0.416], [-1.30, 0.416], [-1.30, 1.02], [1.30, 1.02], [1.30, 0.416], [4.393, 0.416]],
    teeth: [
      [[4.393, 0.416], [3.60, 0.416], [3.42, 0.596], [3.23, 0.596], [2.70, 0.596]],  // into C.2
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
  // the leg starts at the OUT terminal barrel WHEREVER the walks put it (it
  // moved when the 2026-07-31 endShift fixes landed); the run to the via
  // stays in the inter-row In12 band. If the terminal is no longer on the
  // south side this leg stops making sense and the verifier will say so.
  const outT = termViaAt(Q.cells[0], 'OUT');
  const legPts = [
    [outT[0], outT[1]],
    cb(-1.990, 3.021), cb(0.910, 3.021),   // straight run south of the lanes
    cb(1.865, 2.871),                      // north dodge past the (1.87,3.29) barrel
    cb(2.360, 2.921), via,                 // into the via land
  ];
  // The dogleg existed because the 2026-07-30 winding fix stranded the OUT
  // terminal on the SW flat behind the register's west field. The
  // 2026-07-31 terminal walks park it on the NORTH flats instead (2.5 mm
  // from U.6) -- the leg's measured In12 corridor is meaningless from
  // there, so it only arms when the terminal is actually near its measured
  // start.
  const legValid = Math.hypot(outT[0] - (c78x - 2.405), outT[1] - (c78y + 2.985)) < 1.0;
  const emitLeg = () => {
    if (!legValid) { console.log('dogleg: OUT terminal moved off the SW flat -- leg not armed'); return false; }
    runs.push({ net, layer: LANE_LAYER, pts: legPts });
    cvias.push({ net, x: via[0], y: via[1] });
    return true;
  };
  if (!process.env.SR_SWEEP) emitLeg();
  return { x: via[0], y: via[1], emitLeg, legValid };
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
const staticPadRunsInit = [];                    // pad-layer runs, kept for imaging
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
  for (let i = 0; i + 1 < s.pts.length; i++) {
    blockSeg(...s.pts[i], ...s.pts[i + 1], W + CLR + SAFE, blocked);
    // kept with their nets as well, because the NEIGHBOURING stamps' copies of
    // them are obstacles too (see PERIODICITY below)
    staticPadRunsInit.push({ net: s.net, seg: [...s.pts[i], ...s.pts[i + 1]] });
  }
}
// routing net N: N's own pads (by BOARD name: coil_78_A -> coil_78, RCLK_C ->
// RCLK) become passable, as does an optional starting via barrel
const boardName = (net) => net === 'DATA_W' ? `DATA_${centreQuad}`
  : net === 'DATA_E' ? `DATA_${centreQuad + 1}`
  : /^VLOGIC_C[WE]$/.test(net) ? 'VLOGIC'
  : net.replace(/_C$/, '').replace(/_[AB]$/, '');
// --- PERIODICITY ---------------------------------------------------------------
// This copper is a STAMP: the same shapes land on all 42 quads. So a path is
// only finished when it also clears the same path drawn one quad east and one
// band north. Both are pure translations -- two cells across, and two rows up,
// which is exactly where the +-p/4 row stagger cancels -- so a neighbour's
// copper is this copper shifted. What changes is the NET: every name carrying
// a cell index becomes a different net two columns over, and two such nets
// touching is a short. The global bus does not change, and there the
// neighbour's copper really is this copper, so it may touch.
//
// Without this the stamp is legal where it sits and illegal everywhere else:
// measured, three PWM constructions (PWMA_79, PWMA_90, PWMB_79) overran the
// period and collided with their neighbours 12 ways. tilecheck.mjs is the gate.
const NCOL = coils.filter((c) => Math.abs(c[1] - coils[0][1]) < 0.01).length;
const NROW = Math.round(coils.length / NCOL);
const quadAt = (i, j) => quads.find((q) => q.band === Q.band + j && q.pos === Q.pos + i);
const vecTo = (i, j) => {
  const n = quadAt(i, j);
  return n ? [coils[n.cells[0]][0] - c78x, coils[n.cells[0]][1] - c78y] : null;
};
const neg = (v) => v && [-v[0], -v[1]];
const LAT_A = vecTo(1, 0) || neg(vecTo(-1, 0));
const LAT_B = vecTo(0, 1) || neg(vecTo(0, -1));
const LATTICE = [];
if (LAT_A && LAT_B) {
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      if (!i && !j) continue;
      // PERIODIC_OFF=1 restores the pre-tiling behaviour byte for byte, and
      // PERIODIC_ONLY=1,0;0,1 narrows to named neighbours -- "which neighbour
      // costs which net" is the whole question when a construction is lost.
      if (process.env.PERIODIC_OFF) continue;
      if (process.env.PERIODIC_ONLY && !process.env.PERIODIC_ONLY.split(';').includes(`${i},${j}`)) continue;
      LATTICE.push([i * LAT_A[0] + j * LAT_B[0], i * LAT_A[1] + j * LAT_B[1], i, j]);
    }
  }
}
const cellStep = (cell, i, j) => {
  const c2 = (cell % NCOL) + 2 * i, r2 = Math.floor(cell / NCOL) + 2 * j;
  return (c2 < 0 || c2 >= NCOL || r2 < 0 || r2 >= NROW) ? null : r2 * NCOL + c2;
};
// the BOARD net this net's copper carries on the quad (i, j) steps away,
// or null where the lattice runs off the board
const imageName = (net, i, j) => {
  const bn = boardName(net);
  const m = /^(coil|PWMA|PWMB)_(\d+)$/.exec(bn);
  if (m) {
    const c2 = cellStep(+m[2], i, j);
    return c2 == null ? null : `${m[1]}_${c2}`;
  }
  if (/^DATA_\d+$/.test(bn)) {
    const n = quadAt(i, j);
    return n ? `DATA_${+bn.slice(5) + quads.indexOf(n) - centreQuad}` : null;
  }
  return bn;                                     // global bus: same copper
};
// Everything constructed on the pad layer, for imaging. The static `runs`
// (lanes, combs, teeth) are snapshotted when the grid is built; `committed`
// grows as the harness routes.
const staticPadRuns = staticPadRunsInit;
const periodicSegs = function* () {
  for (const r of staticPadRuns) yield r;
  for (const c2 of committed) yield c2;
  // constructed vias are all-layer barrels: their images block B.Cu too
  // (found the hard way: PWMB_78's dive routed straight over PWMB_91's
  // band-NN rise image -- only tilecheck saw it)
  for (const v of cvias) yield { net: v.net, seg: [v.x, v.y, v.x, v.y], via: true };
};
// Block the eight neighbouring stamps' copper, skipping images that land on
// the net being routed (a join) and images that fall off the board.
const blockImages = (me, buf, extra = null) => {
  for (const [dx, dy, i, j] of LATTICE) {
    const src2 = extra ? [...periodicSegs(), ...extra] : [...periodicSegs()];
    for (const c2 of src2) {
      const img = imageName(c2.net, i, j);
      if (img === null || img === me) continue;
      blockSeg(c2.seg[0] + dx, c2.seg[1] + dy, c2.seg[2] + dx, c2.seg[3] + dy,
               (c2.via ? 0.25 + CLR + W / 2 : W + CLR) + SAFE_P, buf);
    }
  }
};

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
  // ... nor foreign CONSTRUCTED copper (the VBUS via-link's corner sits
  // 0.23 mm from SR pad 1 at the flip; the pad's allow zone overrode the
  // link's raster and GND's drop grazed it at 0.185)
  for (const r2 of runs) {
    if (r2.layer !== PAD_LAYER || boardName(r2.net) === bn) continue;
    for (let i2 = 0; i2 + 1 < r2.pts.length; i2++) {
      const [ax, ay] = r2.pts[i2], [bx2, by2] = r2.pts[i2 + 1];
      if (!nearOwn(ax, ay) && !nearOwn(bx2, by2)) continue;
      const L = Math.hypot(bx2 - ax, by2 - ay), n3 = Math.max(1, Math.ceil(L / (GRID * 2)));
      for (let k3 = 0; k3 <= n3; k3++) {
        blockDisc2(ax + ((bx2 - ax) * k3) / n3, ay + ((by2 - ay) * k3) / n3, W + CLR + SAFE, allow, 0);
      }
    }
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
    // same BOARD net = same copper: VLOGIC_CE may touch VLOGIC_C's drop (the
    // chain ends on the pad that drop leaves from). The COIL halves are the
    // one same-board split whose touching is a real short -- keep them apart.
    if (boardName(c2.net) === boardName(net) && !boardName(net).startsWith('coil_')) continue;
    blockSeg(c2.seg[0], c2.seg[1], c2.seg[2], c2.seg[3], W + CLR + SAFE_P, foreignScratch);
  }
  blockImages(boardName(net), foreignScratch);
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
const routeNet = (net, from, to, { emit = true, startVia = null, guide = null, denyPads = null, alsoOpen = null } = {}) => {
  if (!from || !to) { console.error(`HARNESS: missing endpoint for ${net}`); return false; }
  if (startVia) ownBarrels.push({ net, x: startVia.x, y: startVia.y });
  const allow = allowFor(net, startVia);
  // alsoOpen: additional own-net barrels the path may land on (a route
  // between TWO of its own vias -- the gutter doglegs' rise leg ends on the
  // DATA_E portal, which the static raster blocked long before)
  if (alsoOpen) for (const sv of alsoOpen) {
    ownBarrels.push({ net, x: sv.x, y: sv.y });
    blockDisc(sv.x, sv.y, 0.25 + CLR + W / 2 + SAFE, allow);
  }
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
  const me = boardName(net);
  const pref = guide && prefFor(guide);
  const fg = new Uint8Array(foreignFor(net));    // copy: the scratch is reused
  let p = astar(from[0], from[1], to[0], to[1], allow, fg, pref);
  // A path can also clash with its OWN image: PWMA_90 ran 14.675 mm north to
  // south against a 14.665 mm band period and met itself one quad up. The
  // images of a path are not knowable before it exists, so find one, block
  // what it collides with, and look again.
  for (let tries = 0; p && tries < 5; tries++) {
    const mine = [];
    for (let i = 0; i + 1 < p.length; i++) mine.push({ net, seg: [p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]] });
    const selfImg = new Uint8Array(gw * gh);
    blockImages(me, selfImg, mine);
    if (!p.some(([x, y]) => selfImg[gi(toIx(x), toIy(y))])) break;
    let grew = false;
    for (let i = 0; i < fg.length; i++) if (selfImg[i] && !fg[i]) { fg[i] = 1; grew = true; }
    if (!grew) { p = null; break; }
    p = astar(from[0], from[1], to[0], to[1], allow, fg, pref);
    if (tries === 4 && p) console.error(`HARNESS: ${net} still self-overlapping after 5 tries`);
  }
  if (!p) {
    const sx = toIx(from[0]), sy = toIy(from[1]);
    let freeN = 0, allowN = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i2 = gi(sx + dx, sy + dy);
      if ((!blocked[i2] || allow[i2]) && !fg[i2]) freeN++;
      if (allow[i2]) allowN++;
    }
    console.error(`HARNESS: no path for ${net} (start 7x7: ${freeN} free, ${allowN} allowed)`);
    if (process.env.DUMP_GRID && (!process.env.DUMP_NET || process.env.DUMP_NET === net)) {
      // one file per failing attempt (a net can fail twice: harness then
      // fabric), so a single run yields every failure's grid
      routeNet.dumped = routeNet.dumped || new Map();
      const n2 = (routeNet.dumped.get(net) || 0) + 1;
      routeNet.dumped.set(net, n2);
      const dumpPath = `${process.env.DUMP_GRID}.${net}.${n2}.json`;
      const merged = new Uint8Array(blocked);
      for (let i = 0; i < merged.length; i++) if (allow[i]) merged[i] = 0;
      writeFileSync(dumpPath, JSON.stringify({
        gw, gh, gx0, gy0, GRID, from, to,
        rows: Array.from({ length: gh }, (_, iy) => Buffer.from(merged.subarray(iy * gw, (iy + 1) * gw)).toString('base64')),
        // static+allow alone can show start/goal CONNECTED while the A* fails:
        // the committed foreign bands are the wall. Dump them or the flood lies.
        fgRows: Array.from({ length: gh }, (_, iy) => Buffer.from(fg.subarray(iy * gw, (iy + 1) * gw)).toString('base64')),
      }));
      console.error(`grid dumped to ${dumpPath}`);
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
  // the 180-flip orientation (rot ~150): same pocket as the committed 330,
  // pinout swapped -- it gets its own measured harness below
  const srFlip = Math.abs(((((srFp.pads[0].ang || 0) - 150) % 360) + 540) % 360 - 180) < 15;
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
      { const tv = termViaAt(ci, 'IN'); rn(`coil_${ci}_A`, tv, padAt(`U${ci}`, '2'), { startVia: { x: tv[0], y: tv[1] } }); }
      { const tv = termViaAt(ci, 'OUT'); rn(`coil_${ci}_B`, tv, padAt(`U${ci}`, '6'), { startVia: { x: tv[0], y: tv[1] } }); }
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
    {
      const tv = termViaAt(Q.cells[0], 'IN');
      con(`coil_${Q.cells[0]}_A`, tv, padAt(`U${Q.cells[0]}`, '2'), { startVia: { x: tv[0], y: tv[1] } });
    }
    // coil_90_B: freerouting refuses the 0.13 mm thread between cell 90's
    // ring-east via and C90.1 once the harness hems its start; constructed
    // through the measured window
    {
      // the measured window guide is tied to the OLD terminal spot; when the
      // terminal walks (2026-07-31) the whole con is deferred to the
      // shortest-first per-cell loop below -- an unguided _B built here
      // diagonals across U.2's face and walls its own sibling (measured:
      // coil_90_A's goal fully inside 90_B's committed band)
      const tv = termViaAt(Q.cells[2], 'OUT');
      const g0 = gd([[70.95, 62.56]])[0];
      if (Math.hypot(tv[0] - g0[0], tv[1] - g0[1]) < 1.2) {
        con(`coil_${Q.cells[2]}_B`, tv, padAt(`U${Q.cells[2]}`, '6'), {
          startVia: { x: tv[0], y: tv[1] },
          guide: gd([[70.95, 62.56], [70.5, 61.9], [70.15, 61.0], [70.0, 60.2], [70.15, 59.6],
            [70.37, 59.15], [70.37, 58.7], [70.3, 57.75], [69.62, 57.75]]),
        });
      }
    }
    // coil_91_B: the mirrored window (0.11 mm past ring-91-east / C91.1),
    // further hemmed by PWMB_91's pocket vertical
    {
      const tv = termViaAt(Q.cells[3], 'OUT');
      const g0 = gd([[79.42, 62.56]])[0];
      if (Math.hypot(tv[0] - g0[0], tv[1] - g0[1]) < 1.2) {
        con(`coil_${Q.cells[3]}_B`, tv, padAt(`U${Q.cells[3]}`, '6'), {
          startVia: { x: tv[0], y: tv[1] },
          guide: gd([[79.42, 62.56], [78.97, 61.9], [78.62, 61.0], [78.47, 60.2], [78.62, 59.6],
            [78.84, 59.15], [78.84, 58.7], [78.77, 57.75], [78.08, 57.75]]),
        });
      }
    }
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
      // AT THE FLIP (register rotated ~150) the preference INVERTS: the
      // direct trunk hugs x 61.6-61.8, exactly between the west-column pads
      // and their seam taps -- measured, it is what killed all five control
      // drops -- while the dogleg leaves the whole west field to them.
      const cn = `coil_${Q.cells[0]}_B`;
      const deny = [[`U${Q.cells[0]}`, '2']];   // the IN barrel stays a blocked obstacle by itself
      const tryDirect = () => {
        const tv = termViaAt(Q.cells[0], 'OUT');
        con(cn, tv, padAt(`U${Q.cells[0]}`, '6'), { denyPads: deny, startVia: { x: tv[0], y: tv[1] } });
      };
      const tryDogleg = () => {
        if (!coilViaSW.emitLeg()) return;        // terminal moved: leg meaningless
        // the raster was built before this late emission -- later A* work
        // must see the dogleg via as the barrel it is
        blockDisc(coilViaSW.x, coilViaSW.y, 0.25 + CLR + W / 2 + SAFE, blocked);
        con(cn, [coilViaSW.x, coilViaSW.y], padAt(`U${Q.cells[0]}`, '6'), { startVia: coilViaSW, guide: tailGuide, denyPads: deny });
        if (!built.includes(cn)) {
          for (let i2 = runs.length - 1; i2 >= 0; i2--) if (runs[i2].net === cn) runs.splice(i2, 1);
          for (let i2 = cvias.length - 1; i2 >= 0; i2--) if (cvias[i2].net === cn) cvias.splice(i2, 1);
        }
      };
      // dogleg-first only while the terminal really is in the measured SW
      // spot; on the walked-terminal boards the direct hop is 2.5 mm
      if (srFlip && coilViaSW.legValid) { tryDogleg(); if (!built.includes(cn)) tryDirect(); }
      else { tryDirect(); if (!built.includes(cn)) tryDogleg(); }
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
        {
          const tv = termViaAt(regCell, 'OUT');
          con(cn2, tv, padAt(`U${regCell}`, '6'),
            { denyPads: [[`U${regCell}`, '2']], startVia: { x: tv[0], y: tv[1] } });
        }
      }
      if (srFlip && regCell === Q.cells[0]) {
        // at the flip the 79ers' south-gutter constructions hem THEIR OWN
        // cell's coil (R1 lost coil_79_B the run they landed) -- coils
        // first applies to cell 79 too
        const cn3 = `coil_${Q.cells[1]}_B`;
        {
          const tv = termViaAt(Q.cells[1], 'OUT');
          con(cn3, tv, padAt(`U${Q.cells[1]}`, '6'),
            { denyPads: [[`U${Q.cells[1]}`, '2']], startVia: { x: tv[0], y: tv[1] } });
        }
      }
    }
    if (process.env.SR_SWEEP && process.env.SR_CONSTRUCT) {
      // With the 2026-07-31 terminal walks every coil terminal sits on the
      // cell's NORTH flats, 1-2.5 mm from its bridge pad -- and the OTHER
      // constructed coils' pocket hugs seal those short hops for the router
      // (R1 went 0.00 with carry, 999 bare). So construct every remaining
      // quad coil too, shortest-first: the _A hops (IN terminal -> U.2).
      const dropFail = (nm) => { let i3; while ((i3 = harnessFail.indexOf(nm)) >= 0) harnessFail.splice(i3, 1); };
      for (const ci of Q.cells) {
        const an = `coil_${ci}_A`;
        if (!built.includes(an)) {
          dropFail(an);                          // pre-listed by the fallback push; we are attempting it now
          const tv = termViaAt(ci, 'IN');
          con(an, tv, padAt(`U${ci}`, '2'), { startVia: { x: tv[0], y: tv[1] }, denyPads: [[`U${ci}`, '6']] });
        }
        const bn2 = `coil_${ci}_B`;
        if (!built.includes(bn2)) {
          dropFail(bn2);
          const tv = termViaAt(ci, 'OUT');
          con(bn2, tv, padAt(`U${ci}`, '6'), { startVia: { x: tv[0], y: tv[1] }, denyPads: [[`U${ci}`, '2']] });
        }
      }
      // GENERIC parametric harness for a candidate register: stubs on every
      // SR pad (stubFor reads the pad geometry, placement-agnostic), the
      // escape envelope, A* drops from each control net's tap barrel to its
      // stub end, then the PWMs farthest-first -- the measured-guide harness
      // minus the guides. What constructs here is exactly the candidate's
      // own geometry, which is the quantity the sweep ranks.
      const GEN_NETS = SR_NETS.map(([net, pad]) => (pad === '16' ? ['VLOGIC_CE', pad] : [net, pad]));
      // at the flip the even column's NW stubs angle ACROSS the neighbouring
      // pads' approach lanes (measured: pad-10's stub sealed RCLK's face);
      // the west drops approach their own faces straight-on and want no
      // stubs. The odd column's SE stubs stay -- they are the PWM take-offs.
      for (const [net, pad] of GEN_NETS) {
        // the flip wants NO stubs at all: the even column's NW stubs angle
        // across their neighbours' approach lanes (pad-10's sealed pad 8
        // for good), and the odd column's SE stubs wall each other's gutter
        // take-offs at 0.5 pitch -- the comb theorem, south-east edition.
        // Every drop and dogleg leaves from its own pad face instead.
        if (srFlip) {
          const p2 = srFp.pads.find((q) => q.name === pad);
          stubEnd.set(pad, [+(srFp.x + p2.dx).toFixed(3), +(srFp.y + p2.dy).toFixed(3)]);
          continue;
        }
        stubFor(net, pad);
      }
      // the envelope stays generic-only: the flip's drops are ordered and
      // guided straight onto their own faces, and the envelope would seal
      // the under-body channel the VLOGIC chain rides
      if (!srFlip) blockEnvelope();
      const hasStub = (pad) => {
        const e = stubEnd.get(pad);
        const p2 = srFp.pads.find((q) => q.name === pad);
        return Math.hypot(e[0] - (srFp.x + p2.dx), e[1] - (srFp.y + p2.dy)) > 0.5;
      };
      const dropOf = (net, pad, guide) => {
        const t = taps.find((t2) => t2.net === net && t2.kind !== 'stub');
        con(net, [t.x, t.y], stubEnd.get(pad), { startVia: t, guide });
      };
      if (!srFlip) {
        for (const [net, pad] of [['SCLK_C', '6'], ['RCLK_C', '8'], ['OE_N_C', '10'], ['DATA_W', '12'],
          ['DATA_E', '2'], ['GND_C', '1'], ['VLOGIC_C', '4'], ['VLOGIC_CE', '16']]) {
          dropOf(net, pad);
        }
        for (const [net, srPad, cell, uPad] of [
          [`PWMB_${Q.cells[3]}`, '3', Q.cells[3], '5'], [`PWMA_${Q.cells[3]}`, '5', Q.cells[3], '1'],
          [`PWMB_${Q.cells[2]}`, '7', Q.cells[2], '5'], [`PWMA_${Q.cells[2]}`, '9', Q.cells[2], '1'],
          [`PWMB_${Q.cells[1]}`, '11', Q.cells[1], '5'], [`PWMA_${Q.cells[1]}`, '13', Q.cells[1], '1'],
          [`PWMB_${Q.cells[0]}`, '15', Q.cells[0], '5'], [`PWMA_${Q.cells[0]}`, '14', Q.cells[0], '1'],
        ]) {
          con(net, stubEnd.get(srPad), padAt(`U${cell}`, uPad));
        }
      } else {
        // MEASURED FLIP HARNESS (derived 2026-07-30 on srswp4; guides in
        // board coords for the centre quad, generalising like every other
        // guide because each quad is the same stamp). The even column faces
        // the west seam: five short parallel WSW drops in column order,
        // DATA_W diving before OE_N (their targets cross). VLOGIC_CE chains
        // pad 16 to pad 4 through the under-body channel -- at the flip the
        // bay ring sits at the column's NORTH end so the channel's south
        // half is clear (the mirror of the committed orientation's
        // pad-4-only rule). GND crosses east to the internal barrel through
        // the A-column's 65.3-66.9 y-gap. The odd column faces the old
        // east-pocket corridors: PWMB_79 rides the y~69.8 south-of-ladder
        // window east (the corridor the east-drops experiment measured and
        // shelved as "valid if SR ever moves"); DATA_E threads the
        // ring/C78/pad-1 squeeze north-about; PWMA_78 climbs the west field
        // (freed by preferring the dogleg) to the mini-gate band and enters
        // U78.1 from the north-west; PWMB_78 loops south-east, dodges the
        // dogleg via, threads the C78 pad gap and the 0.06 mm-band slit
        // between C78.2 and the GND riser to U78.5's east face; the 90 pair
        // crosses the internal seam's via-free section (y < 64.4) and rides
        // cell 79's west flank north to the row-3 y-56.35 band; the 91 pair
        // goes last so its long free-form paths dodge every committed
        // corridor.
        // All five west drops construct: PWMA_78's climb -- the reason RCLK
        // and OE_N were once exiled to the router (any north-south lane in
        // the face strip crosses every drop, five-to-one) -- is gone; its
        // net leaves south through the gutter fabric instead.
        // Exit PERPENDICULAR (0.55 straight off the face) before fanning --
        // a shallow-angle exit sweeps the committed band across the next
        // pad's funnel (flood-measured: SCLK's sealed RCLK's face, DATA_W's
        // sealed OE_N's). Fans nest by tap depth; OE_N, whose tap is deeper
        // than DATA_W's despite the shallower pad, descends EAST of
        // DATA_W's diagonal (the lane PWMA_78's climb vacated) and turns
        // west underneath it.
        dropOf('VLOGIC_C', '4', gd([[63.70, 66.05], [63.18, 65.75], [62.3, 65.3], [61.5, 64.95], [61.04, 64.85]]));
        dropOf('SCLK_C', '6', gd([[63.45, 66.48], [62.93, 66.18], [62.3, 66.35], [61.6, 66.9], [61.0, 67.45], [60.47, 67.79]]));
        // three deep-southwest taps, two physical lanes (the nested fan and
        // the vacated-climb descent) -- flood-proven, one net must ride the
        // router. OE_N loses the seat: DATA_W is the quad's serial INPUT
        // (chain-breaking if missing) and RCLK is the latch; OE_N is a
        // global enable a board-level pull can cover at worst.
        dropOf('RCLK_C', '8', gd([[63.20, 66.92], [62.68, 66.62], [62.05, 66.8], [61.5, 67.3], [61.2, 67.8], [61.04, 68.21]]));
        dropOf('DATA_W', '12', gd([[62.70, 67.78], [62.18, 67.48], [61.6, 67.7], [61.15, 68.1], [60.8, 68.45], [60.47, 68.63]]));
        dropOf('OE_N_C', '10', gd([[62.95, 67.35], [62.43, 67.05], [62.1, 67.3], [62.05, 68.0], [62.0, 68.7], [61.7, 69.1], [61.3, 69.15], [61.04, 69.05]]));
        con('VLOGIC_CE', padAt(sr, '16'), padAt(sr, '4'), {
          guide: gd([[62.67, 68.92], [63.1, 68.15], [63.5, 67.3], [63.65, 66.6], [63.70, 66.3]]),
        });
        dropOf('GND_C', '1', gd([[66.5, 66.95], [67.4, 66.5], [68.3, 66.11], [69.50, 66.11]]));
        // --- gutter doglegs ------------------------------------------------
        // Flood-measured: the dogleg via, the tail's start segment, J66.IN,
        // U66.2 and the row gutter's crossover-via cluster close each
        // other's gaps -- there is NO B.Cu crossing of the row gutter east
        // of x 66.3. The In12 gutter band (y ~c78y+2.72..+4.5, between the
        // OE_N lane and row 5's stack) is empty but for those barrels, so
        // each eastbound net drops through its own PROBED via, rides its own
        // In12 y-lane, and rises near its destination -- the coil_78_B
        // dogleg, generalised. Sites are probed against the FULL board
        // (winding hexes + vias + pads + constructed copper; the r1-proxy
        // trap cost 8 real DRC hits once already).
        const gGeom = pcbCoilGeometry(cfg);
        const coilKeepR2 = gGeom.halfOut + gGeom.trace / 2;
        const hexD = (dx2, dy2) => {
          let m = -1e9;
          for (let k2 = 0; k2 < 6; k2++) {
            const a2 = (k2 * Math.PI) / 3;
            m = Math.max(m, dx2 * Math.cos(a2) + dy2 * Math.sin(a2));
          }
          return m;
        };
        const ptSeg2 = (px, py, ax, ay, bx, by) => {
          const dx2 = bx - ax, dy2 = by - ay, L2 = dx2 * dx2 + dy2 * dy2;
          const t2 = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx2 + (py - ay) * dy2) / L2)) : 0;
          return Math.hypot(px - (ax + t2 * dx2), py - (ay + t2 * dy2));
        };
        const siteOK = (x, y, net, why) => {
          const no = (r2) => { if (why) why.push(r2); return false; };
          for (const [cx2, cy2] of coils) {
            if (Math.hypot(x - cx2, y - cy2) < 6.5 && hexD(x - cx2, -(y - cy2)) < coilKeepR2 + CLR + 0.25 + 0.03) return no('hex');
          }
          for (const v of board.vias) if (Math.hypot(x - v.x, y - v.y) < 0.6) return no('via');
          for (const v of cvias) if (Math.hypot(x - v.x, y - v.y) < 0.6) return no('cvia');
          for (const tb of allTabs) {
            if (Math.abs(tb[0] - x) > 2 && Math.abs(tb[2] - x) > 2) continue;
            if (ptSeg2(x, y, tb[0], tb[1], tb[2], tb[3]) < 0.25 + CLR + gPlan.trace / 2 + 0.02) return no('tab');
          }
          for (const fp of board.fps) {
            if (Math.hypot(x - fp.x, y - fp.y) > 4) continue;
            for (const p2 of fp.pads) {
              if (inPad(x, y, { x: fp.x + p2.dx, y: fp.y + p2.dy, w: p2.w, h: p2.h, rot: -((fp.rot || 0) + (p2.ang || 0)) }, 0.25 + CLR + 0.03)) return no('pad:' + fp.ref);
            }
          }
          for (const r2 of runs) {
            if (r2.net === net) continue;         // own copper may touch its own barrel
            for (let i2 = 0; i2 + 1 < r2.pts.length; i2++) {
              if (ptSeg2(x, y, r2.pts[i2][0], r2.pts[i2][1], r2.pts[i2 + 1][0], r2.pts[i2 + 1][1]) < 0.25 + CLR + W / 2 + 0.03) return no('run:' + r2.net);
            }
          }
          return true;
        };
        const findSite = ([px, py], net, yLo = c78y + 2.77, yHi = c78y + 4.6, xLo = -1e9, xHi = 1e9) => {
          let best = null;
          for (let dy2 = -0.9; dy2 <= 0.9 + 1e-9; dy2 += 0.05) {
            for (let dx2 = -1.8; dx2 <= 1.8 + 1e-9; dx2 += 0.05) {
              const x = px + dx2, y = py + dy2;
              if (y < yLo || y > yHi || x < xLo || x > xHi) continue;
              if (!siteOK(x, y, net)) continue;
              const d = Math.hypot(dx2, dy2);
              if (!best || d < best.d) best = { x: +x.toFixed(3), y: +y.toFixed(3), d };
            }
          }
          if (process.env.FABSITE_WHY === net && best) {
            const why = [];
            for (const [x, y] of [[best.x, best.y], [px, py]]) {
              const w2 = [];
              siteOK(x, y, net, w2);
              why.push(`(${x.toFixed(2)},${y.toFixed(2)}):${w2[0] || 'OK'}`);
            }
            console.error(`FABSITE_WHY ${net}: best ${why[0]} pref ${why[1]}`);
          }
          if (!best && process.env.FABSITE_DEBUG) {
            const hist = new Map();
            for (let dy2 = -0.9; dy2 <= 0.9 + 1e-9; dy2 += 0.1) {
              for (let dx2 = -1.8; dx2 <= 1.8 + 1e-9; dx2 += 0.1) {
                const x = px + dx2, y = py + dy2;
                if (y < yLo || y > yHi) continue;
                const why = [];
                siteOK(x, y, net, why);
                hist.set(why[0], (hist.get(why[0]) || 0) + 1);
              }
            }
            console.error(`FABSITE ${net} @(${px.toFixed(2)},${py.toFixed(2)}) y[${yLo.toFixed(2)},${yHi.toFixed(2)}]: ` +
              [...hist].map(([k2, v2]) => `${k2}=${v2}`).join(' '));
          }
          return best;
        };
        const gutterPath = (a, b, laneY) => {
          const pts = [[a.x, a.y], [a.x, laneY]];
          const dir = Math.sign(b.x - a.x) || 1;
          const blockers = [...board.vias, ...cvias]
            .filter((v) => (v.x - a.x) * dir > 0.3 && (b.x - v.x) * dir > 0.3 && Math.abs(v.y - laneY) < 0.44)
            .sort((u, v) => (u.x - v.x) * dir);
          for (const v of blockers) {
            const yj = +(v.y + (laneY <= v.y ? -0.46 : 0.46)).toFixed(3);
            pts.push([+(v.x - 0.5 * dir).toFixed(3), laneY], [v.x, yj], [+(v.x + 0.5 * dir).toFixed(3), laneY]);
          }
          pts.push([b.x, laneY], [b.x, b.y]);
          return pts.map(([x, y]) => [+(+x).toFixed(3), +(+y).toFixed(3)]);
        };
        if (process.env.FABSITE_MAP) {
          // one-shot legality map of the via-site bands, for choosing fabric
          // drop/rise prefs against the REAL board (sites move whenever the
          // winding walks; hand-measured prefs go stale silently)
          const out = [];
          for (const [y1, y2, tag] of [[c78y + 2.75, c78y + 4.65, 'S'], [c78y - 4.55, c78y - 2.25, 'N'],
            [c78y - 7.332 - 4.65, c78y - 7.332 - 2.75, 'NN']]) {
            for (let y = y1; y <= y2 + 1e-9; y += 0.05) {
              for (let x = c78x - 8.5; x <= c78x + 18 + 1e-9; x += 0.05) {
                if (siteOK(x, y, '?')) out.push([+x.toFixed(3), +y.toFixed(3), tag]);
              }
            }
          }
          writeFileSync(process.env.FABSITE_MAP, JSON.stringify(out));
          console.error(`FABSITE_MAP: ${out.length} legal sites written to ${process.env.FABSITE_MAP}`);
        }
        const gd1 = (x, y) => gd([[x, y]])[0];
        const gutterNet = (net, fromPt, dropPref, laneYOff, risePref, riseLeg, dropGuide = null) => {
          const dv = findSite(dropPref, net);
          const rvS = findSite(risePref, net);
          if (!dv || !rvS) {
            console.error(`GUTTER: no ${dv ? 'rise' : 'drop'} via site for ${net}`);
            if (!harnessFail.includes(net)) harnessFail.push(net);
            return;
          }
          // undo by TRUNCATION, not net-filter: DATA_E's original In12 lane
          // and portal predate this call and must survive a withdrawal
          const mark = { r: runs.length, c: cvias.length, m: committed.length };
          const undo = () => {
            runs.length = mark.r;
            cvias.length = mark.c;
            committed.length = mark.m;
            if (!harnessFail.includes(net)) harnessFail.push(net);
          };
          cvias.push({ net, x: dv.x, y: dv.y }, { net, x: rvS.x, y: rvS.y });
          runs.push({ net, layer: LANE_LAYER, pts: gutterPath(dv, rvS, +(c78y + laneYOff).toFixed(3)) });
          if (!routeNet(net, fromPt, [dv.x, dv.y], { startVia: dv, guide: dropGuide })
            || !riseLeg(rvS)) { undo(); return; }
          built.push(net);
          blockDisc(dv.x, dv.y, 0.25 + CLR + W / 2 + SAFE, blocked);
          blockDisc(rvS.x, rvS.y, 0.25 + CLR + W / 2 + SAFE, blocked);
        };
        const hugX = (westCellX) => +(westCellX + FABRIC_HUG_X).toFixed(4);
        const emitB = (net, pts) => {
          const P = pts.map(([x2, y2]) => [+(+x2).toFixed(3), +(+y2).toFixed(3)]);
          runs.push({ net, layer: PAD_LAYER, pts: P });
          for (let i2 = 0; i2 + 1 < P.length; i2++) committed.push({ net, seg: [P[i2][0], P[i2][1], P[i2 + 1][0], P[i2 + 1][1]] });
        };
        const fabNet = (net, build) => {
          const mark = { r: runs.length, c: cvias.length, m: committed.length };
          if (build()) {
            built.push(net);
            let i3;
            while ((i3 = harnessFail.indexOf(net)) >= 0) harnessFail.splice(i3, 1);
            for (let i2 = mark.c; i2 < cvias.length; i2++) blockDisc(cvias[i2].x, cvias[i2].y, 0.25 + CLR + W / 2 + SAFE, blocked);
          } else {
            runs.length = mark.r; cvias.length = mark.c; committed.length = mark.m;
            if (!harnessFail.includes(net)) harnessFail.push(net);
            console.error(`FABRIC: ${net} withdrawn`);
          }
        };
        // --- 90/91 QUARTET via band NN (2026-08-27) ----------------------
        // The old B.Cu treks to U90/U91 died under periodicity: their east
        // extents landed one 16.93 mm period over on the west face (the
        // tilecheck [1,0] conflicts), and every re-route displaced a west
        // drop. The destinations sit just SOUTH of the row-2|row-3 gutter
        // (band NN), which is EMPTY -- so each net rides the fabric NORTH.
        // Measured truths this shape is built on (via list dumped from the
        // board, 0.39 trace-to-via / 0.19 trace-to-trace / 0.59 via-to-via):
        //  - the south gutter's via field leaves exactly TWO clean In12
        //    lanes: y 69.52 (between the OE_N lane and the 70.02 via row)
        //    and y 71.25 (south of the 70.79 row); verticals joining them
        //    survive only at x <= 66.08 or isolated windows, so all four
        //    drops sit in the WEST box and the dives nest by stub depth;
        //  - the inter-row band has clean In12 lanes at y 62.35 and
        //    63.95/64.15; the DATA_E via and the 70.71/71.29 crossovers
        //    seal the 63.2-63.5 diagonal, so one 90-net exits the internal
        //    hug NORTH and the other SOUTH;
        //  - rows stagger half a pitch, so every N-S line staircases: row-1
        //    hug, In12 jog, row-2 hug (one winding layer per net, a row-2
        //    lane and a row-1 lane on the same layer are one period apart);
        //  - band-S In12 y aliases band NN minus 14.665: the rides at 69.52
        //    and 71.25 image onto y 54.86/56.59 there, which is why the
        //    rises sit at 55.35 and 56.12, 0.4+ clear of both.
        if (FABRIC.length >= 6) {
          const [, , FAB_90B, FAB_90A, FAB_91B, FAB_91A] = FABRIC;
          const HINTq = hugX(c78x), HE79q = hugX(c78x + pitch), H90q = hugX(c78x + pitch / 2);
          const QX = (dx) => +(c78x + dx).toFixed(3), QY = (dy) => +(c78y + dy).toFixed(3);
          const sites = (net, list) => {
            const out = {};
            for (const [k, px, py, y1, y2, x1, x2] of list) {
              out[k] = findSite([QX(px), QY(py)], net, QY(y1), QY(y2),
                x1 === undefined ? -1e9 : QX(x1), x2 === undefined ? 1e9 : QX(x2));
              if (!out[k]) { console.error(`FABRIC ${net}: no ${k} site`); return null; }
            }
            return out;
          };
          const V = (net, S) => { for (const k of Object.keys(S)) cvias.push({ net, x: S[k].x, y: S[k].y }); };
          // PWMB_91 (pad 3 -> U91.5), In7, the S-slot rider. Pad 5 is
          // reachable ONLY through the U91 inter-column channel from band
          // NN (C91's pads, both comb risers and the GND tooth wall every
          // other face -- measured). A junction via near the 91|92 wedge is
          // impossible -- any such via's west image lands ON the row-2 OE_N
          // lane -- so the whole trek stays on In7: down the E79 hug, a
          // vialess gutter-zigzag diagonal across the inter-row band, up
          // the 91|92 hug, the pinch leg under the row-3 hexes (dodging
          // PWMA_91's drop/jB images), and the channel tail.
          fabNet(`PWMB_${Q.cells[3]}`, () => {
            const net = `PWMB_${Q.cells[3]}`;
            const S = sites(net, [['drop', 0.767, 4.167, 3.997, 4.317, 0.667, 0.867],
              ['jB', 11.217, 3.117, 3.017, 3.217, 11.067, 11.367],
              ['rise', 14.867, -11.413, -11.483, -11.313, 14.807, 14.967]]);
            if (!S) return false;
            V(net, S);
            runs.push({ net, layer: LANE_LAYER, pts: [[S.drop.x, S.drop.y], [S.drop.x, QY(2.787)],
              // the 69.52 slot is via-free EXCEPT the ladder OE_N barrels at
              // y 69.25 (x 69.01/69.58 and 77.48/78.05): hop to the 69.67
              // thread band over each seam
              [QX(3.317), QY(2.787)], [QX(3.667), QY(2.937)], [QX(4.567), QY(2.937)], [QX(4.917), QY(2.787)],
              [S.jB.x, QY(2.787)], [S.jB.x, S.jB.y]] });
            // the In7 leg rides the 69.67 thread band east over BOTH seam
            // ladders to the E79 hug (the jB sits west of the east seam so
            // its image stays clear of PWMB_78's west gateway)
            runs.push({ net, layer: FAB_91B, pts: [[S.jB.x, S.jB.y], [QX(11.717), QY(2.937)], [QX(12.167), QY(2.937)],
              [QX(13.067), QY(2.937)], [QX(13.262), QY(2.977)],
              [HE79q, QY(-2.833)],
              [QX(14.417), QY(-3.333)], [QX(15.317), QY(-4.033)], [QX(16.417), QY(-4.483)], [QX(17.117), QY(-4.333)],
              [H90q + pitch, QY(-4.353)], [H90q + pitch, QY(-10.113)],
              // the pinch: under the 91|92 columns' last vias, along the
              // row-3 hex floor, down to the rise; the B.Cu tail loops in
              // from the EAST (the channel mouth x-column is one period from
              // the jB/leg zone, so nothing of this net may sit there)
              [QX(17.437), QY(-9.783)], [QX(16.817), QY(-9.883)], [QX(16.217), QY(-10.133)], [QX(15.567), QY(-10.633)],
              [QX(15.117), QY(-11.133)], [S.rise.x, S.rise.y]] });
            emitB(net, [[S.rise.x, S.rise.y], [QX(14.567), QY(-11.133)], [QX(14.267), QY(-10.633)], [QX(14.097), QY(-10.233)],
              [QX(14.087), QY(-8.628)], [QX(14.917), QY(-8.628)]]);
            return routeNet(net, stubEnd.get('3'), [S.drop.x, S.drop.y], { startVia: S.drop,
              guide: gd([[66.2, 68.2], [66.1, 69.2], [66.0, 70.0], [65.95, 70.6]]) });
          });
          // PWMA_91 rides the ROUTER: with six fabric layers declared it can
          // via-hop mid-route, and every constructible corridor to U91.1 is
          // measured shut (the E-seam jB zone, the channel mouth and the
          // west face are all one period apart -- three nets' worth of
          // geometry cannot share that column; PWMB_91 got the slot).
          // PWMB_90 (pad 7 -> U90.5), In9: wedge corridor along cell 78's
          // SE diagonal, the y~69.66 thread (the only In-layer line past
          // J66.IN), HINT hug down to cell 90's S vertex (y~63.5), the SE-
          // diagonal exit north of the 70.71 crossover, In12 to the 90|91
          // hug, band NN, and the U90 inter-column channel into pad 5.
          fabNet(`PWMB_${Q.cells[2]}`, () => {
            const net = `PWMB_${Q.cells[2]}`;
            const S = sites(net, [['drop', 3.067, 3.267, 2.867, 3.297, 2.917, 3.097],
              ['jTop', 6.817, -4.233, -4.353, -4.053, 6.647, 7.297],
              ['jMid', 10.167, -4.133, -4.303, -3.933, 10.047, 10.997],
              ['rise', 6.717, -11.383, -11.533, -11.233]]);
            if (!S) return false;
            V(net, S);
            runs.push({ net, layer: FAB_90B, pts: [[S.drop.x, S.drop.y], [QX(3.317), QY(2.947)],
              [HINTq, QY(2.947)],
              [HINTq, QY(-3.233)], [QX(5.267), QY(-3.273)],
              [QX(5.867), QY(-3.373)], [QX(6.717), QY(-3.933)],
              [S.jTop.x, S.jTop.y]] });
            runs.push({ net, layer: LANE_LAYER, pts: gutterPath(S.jTop, S.jMid, QY(-4.383)) });
            runs.push({ net, layer: FAB_90B, pts: [[S.jMid.x, S.jMid.y], [QX(9.577), QY(-4.353)],
              [H90q, QY(-4.353)], [H90q, QY(-9.633)],
              [QX(8.567), QY(-9.783)], [QX(8.217), QY(-9.833)],
              [QX(7.417), QY(-9.883)], [QX(6.967), QY(-10.233)],
              [QX(6.767), QY(-10.833)], [S.rise.x, S.rise.y]] });
            const u = padAt(`U${Q.cells[2]}`, '5');
            emitB(net, [[S.rise.x, S.rise.y], [QX(5.817), QY(-10.883)],
              [QX(5.627), QY(-10.333)], [QX(5.627), u[1]], [+(u[0] - 0.3).toFixed(3), u[1]]]);
            return routeNet(net, stubEnd.get('7'), [S.drop.x, S.drop.y], { startVia: S.drop,
              guide: gd([[66.3,68.85],[66.9,69.25],[67.5,69.6],[68.0,69.85]]) });
          });
          // PWMA_90 (pad 9 -> U90.1), In8: own corridor one slot over,
          // NORTH band exit, 64.15 lane, H90 hug, tail into pad 1.
          fabNet(`PWMA_${Q.cells[2]}`, () => {
            const net = `PWMA_${Q.cells[2]}`;
            const S = sites(net, [['drop', 2.477, 2.947, 2.867, 3.297, 2.367, 2.617],
              ['jTop', 5.967, -2.583, -2.783, -2.493],
              ['jMid', 10.117, -3.533, -3.633, -3.433, 10.017, 10.267],
              ['rise', 8.267, -10.613, -10.713, -10.483]]);
            if (!S) return false;
            V(net, S);
            runs.push({ net, layer: FAB_90A, pts: [[S.drop.x, S.drop.y], [QX(2.917), QY(2.847)],
              [QX(3.367), QY(2.887)], [HINTq, QY(2.957)], [HINTq, QY(-2.133)],
              [QX(5.267), QY(-2.313)], [S.jTop.x, S.jTop.y]] });
            runs.push({ net, layer: LANE_LAYER, pts: gutterPath(S.jTop, S.jMid, QY(-2.583)) });
            runs.push({ net, layer: FAB_90A, pts: [[S.jMid.x, S.jMid.y], [QX(9.867), QY(-3.833)],
              // thread the 0.9 mm gap between the 74.48 crossover and
              // PWMB_90's junction via, then under the crossover to the hug
              [QX(9.737), QY(-4.013)], [QX(9.667), QY(-4.283)],
              [H90q, QY(-4.303)],
              [H90q, QY(-10.183)], [QX(8.667), QY(-10.383)], [S.rise.x, S.rise.y]] });
            emitB(net, [[S.rise.x, S.rise.y], [QX(7.667), QY(-10.283)], [QX(7.317), QY(-10.433)], [QX(7.117), QY(-10.529)]]);
            return routeNet(net, stubEnd.get('9'), [S.drop.x, S.drop.y], { startVia: S.drop,
              guide: gd([[65.9,69.35],[66.5,69.6],[67.0,69.68],[67.4,69.68]]) });
          });
          // PWMA_79: MEASURED DEAD (2026-08-27). Its In11 chain (W drop,
          // HW78 hug, band-N diagonal, A* tail) verifies locally but can
          // never tile: the W-hug entry thread is triple-sealed by
          // PWMB_78's drop, the 61.78/70.18 board via and PWMB_91's
          // band-NN rise IMAGE (every candidate line violates one of the
          // three, and cell 78's SW hex floor closes the detours), and a
          // W-box drop's own image lands on PWMB_91's pinch. It rides the
          // router with the rest.
          if (process.env.FABRIC_A79) {
          // PWMA_79 (pad 13 -> U79.1), In11: W drop, HW78 hug, then a
          // vialess diagonal along the inter-row gutter's SOUTH edge -- the
          // whole run on one winding layer, under the In12 lanes and clear
          // of every other layer's hugs -- to a rise in the 90|91 wedge and
          // a short B.Cu tail into the pad's north face.
          fabNet(`PWMA_${Q.cells[1]}`, () => {
            const net = `PWMA_${Q.cells[1]}`;
            const S = sites(net, [['drop', -0.883, 4.567, 4.417, 4.647, -0.983, -0.733],
              ['rise', 2.117, -3.983, -4.133, -3.833, 1.967, 2.267]]);
            if (!S) return false;
            V(net, S);
            const HW78q = hugX(c78x - pitch);
            runs.push({ net, layer: FABRIC[0], pts: [[S.drop.x, S.drop.y], [QX(-1.333), QY(4.117)],
              [QX(-1.683), QY(3.617)], [QX(-2.483), QY(2.967)], [QX(-3.123), QY(2.967)], [hugX(c78x - pitch), QY(2.977)],
              [hugX(c78x - pitch), QY(-2.633)],
              [QX(-3.183), QY(-2.833)],
              [QX(-2.683), QY(-3.333)],
              [QX(-2.183), QY(-3.583)],
              [QX(-1.883), QY(-4.033)],
              [QX(-0.983), QY(-4.333)],
              [QX(-0.283), QY(-4.433)],
              [QX(0.717), QY(-4.333)],
              [QX(1.117), QY(-4.533)],
              [QX(1.817), QY(-4.333)], [S.rise.x, S.rise.y]] });
            const u = padAt(`U${Q.cells[1]}`, '1');
            // the band-N tail east is left to the periodicity-aware A*: the
            // wedge next to U79 has no legal via at all (the OE_N row-2
            // lane, the 74.48 crossover and both 90-nets' junction vias
            // fence every candidate), so the rise sits back west and the
            // tail worms 8.8 mm on B.Cu -- band N y62-63.5 aliases only
            // off-stamp, so the A* is free there
            return routeNet(net, stubEnd.get('13'), [S.drop.x, S.drop.y], { startVia: S.drop,
              guide: gd([[64.9,70.2],[64.6,70.6],[64.45,70.9],[64.35,71.1]]) })
              && routeNet(net, [S.rise.x, S.rise.y], [u[0], +(u[1] - 0.25).toFixed(3)], { startVia: S.rise,
                guide: gd([[68.0,62.9],[69.3,63.0],[70.2,63.2],[71.5,63.1],[72.5,63.2],[73.4,63.3],[74.4,63.4],[75.3,63.5],[76.0,63.3]]) });
          });
          }

          //
        }
        // PWMB_79: east through the seam's A/B-column inter-via gaps
        // (A 66.95-67.79, B 66.11-68.21 -- the only B.Cu crossings left),
        // the y~66.7 jog band between the GND-B via and the tail's top,
        // the shelf south of cell 79's bay ring, to U79.5's west face
        con(`PWMB_${Q.cells[1]}`, stubEnd.get('11'), padAt(`U${Q.cells[1]}`, '5'), {
          guide: gd([[65.5, 69.35], [66.2, 68.9], [67.0, 68.3], [67.8, 67.75], [68.5, 67.5], [68.93, 67.35],
            [69.50, 67.15], [69.95, 66.9], [70.5, 66.75], [71.2, 66.7], [72.0, 66.5], [72.5, 66.1],
            [72.95, 65.6], [73.6, 65.5], [74.4, 65.5], [75.0, 65.4], [75.59, 65.09], [76.04, 65.09]]),
        });
        // DATA_E: the under-body channel beside the VLOGIC chain, out the
        // south mouth to its drop via, ride east, rise south of the ladder
        // and enter the portal from the SOUTH (J78.IN denies the west face,
        // the B-column the east)
        {
          const portalT = taps.find((t2) => t2.net === 'DATA_E' && t2.kind !== 'stub');
          // the rise leg STARTS at the portal: the portal's only legal
          // approach is a sub-raster sliver past J78.IN that exists solely
          // inside the startVia's allow disc (exactly how the committed
          // orientation's drop reached it)
          if (FABRIC.length < 3) gutterNet('DATA_E', padAt(sr, '2'), gd1(63.8, 70.9), 3.47, gd1(69.85, 69.6),
            (rv3) => routeNet('DATA_E', [portalT.x, portalT.y], [rv3.x, rv3.y], {
              startVia: portalT, alsoOpen: [{ x: rv3.x, y: rv3.y }],
              guide: gd([[68.93, 68.63], [68.8, 69.15], [69.3, 69.62], [69.85, 69.62]]),
            }),
            gd([[64.36, 65.9], [64.15, 66.6], [63.8, 67.4], [63.5, 68.2], [63.25, 69.0], [63.4, 69.7], [63.7, 70.4]]));
        }
        // PWMA_78 goes to the router: its only corridor (the west-face
        // climb) crosses EVERY west drop -- flood-measured mutual
        // exclusion, five drops beat one PWM. The structural fix is
        // re-mapping which register pad drives which cell (qFn in quadgen
        // is convention, not geometry) -- a co-design lever for later.
        con(`PWMA_${Q.cells[1]}`, stubEnd.get('13'), padAt(`U${Q.cells[1]}`, '1'));
        // the 90/91 quartet is constructed in the band-NN fabric block
        // ABOVE (before PWMB_79's trek could wall the dives); the old B.Cu
        // treks died under periodicity -- their east extents aliased into
        // the west face one period over (tilecheck's [1,0] conflicts).
        // --- WINDING-LAYER FABRIC (task 15) ------------------------------
        // Everything left is a register-pocket escape whose only corridor is
        // a single thread. The fabric gives each a via near its pad, a ride
        // through a seam gutter on a winding layer (clean by banFlats), an
        // In12 trunk in the empty inter-row bands, and a rise onto/next to
        // its destination. One lane per ladder column per fabric layer.
        // The interleaved ladder is IMPASSABLE to column-riding fabric: the
        // 0.39-clearance discs of an A via and its diagonal B neighbour
        // overlap (centres 0.708 apart), so no jog shape threads them.
        // What DOES run the whole seam is a straight vertical HUGGING the
        // west cell's hex at copper+0.15: it clears every A-column barrel by
        // ~0.41 and the B column by ~0.98, needs no jogs at all, and each
        // fabric layer carries its own independent copy of the lane.
        // (Junction VIAS cannot sit on the hug line -- a via land needs 0.34
        // from the winding -- so rides end with short angled legs to via
        // sites out in the band pockets.)
        if (FABRIC.length >= 3 && !built.includes('VLOGIC_CE')) {
          // VLOGIC_CE first (pure B.Cu): the pad16 <-> pad4 chain through the
          // under-body channel; the gate-38 ring sits at the column's NE end
          // so the channel's SW half is clear. Same board net as VLOGIC_C's
          // drop (foreignFor exempts the meeting inside pad 4).
          fabNet('VLOGIC_CE', () => routeNet('VLOGIC_CE', padAt(sr, '16'), padAt(sr, '4'), {
            guide: [[62.45, 69.0], [62.82, 68.55], [63.2, 67.9], [63.55, 67.2], [63.75, 66.6], [63.80, 66.35]],
          }));
        }
        if (FABRIC.length >= 3) {
          const [FAB_A, FAB_B, FAB_C] = FABRIC;
          const HW78 = hugX(c78x - pitch), HINT = hugX(c78x), HE79 = hugX(c78x + pitch);
          const bandS = [c78y + 2.75, c78y + 4.65];       // south gutter In12 band
          const bandN = [c78y - 4.55, c78y - 2.25];       // row-2/3 In12 band
          const YLEG = +(c78y + 2.977).toFixed(3);        // the over-the-wedge-tip lane: 0.41 south
          //   of OE_N-B, 0.43 north of the row-1 crossover that sits IN the hug line
          // south entry: drop via east of the row-1 cell's N wedge, a wire
          // leg west over the wedge tip at YLEG, then the hug lane north.
          const southIn = (drop, hx) => [[drop.x, drop.y], [+(drop.x - 0.05).toFixed(3), +(c78y + 3.267).toFixed(3)],
            [+(hx + 0.55).toFixed(3), YLEG], [hx, YLEG]];
          // PWMA_78: pad 14 -> SW hug -> wedge-east drop -> W78 hug lane
          // (In11) -> row-2/3 band east -> rise ON U78.1's north face.
          fabNet(`PWMA_${Q.cells[0]}`, () => {
            const net = `PWMA_${Q.cells[0]}`;
            const drop = findSite([c78x - 3.53, c78y + 3.62], net, c78y + 3.4, c78y + 4.65);
            const jTop = findSite([c78x - 4.23, c78y - 3.88], net, ...bandN);
            const rise = findSite([padAt(`U${Q.cells[0]}`, '1')[0], c78y - 3.63], net, ...bandN);
            if (!drop || !jTop || !rise) { console.error(`FABRIC ${net}: no ${!drop ? 'drop' : !jTop ? 'jTop' : 'rise'} site`); return false; }
            cvias.push({ net, x: drop.x, y: drop.y }, { net, x: jTop.x, y: jTop.y }, { net, x: rise.x, y: rise.y });
            runs.push({ net, layer: FAB_A, pts: [...southIn(drop, HW78), [HW78, +(jTop.y + 0.45).toFixed(3)], [jTop.x, jTop.y]] });
            runs.push({ net, layer: LANE_LAYER, pts: gutterPath(jTop, rise, +(c78y - 2.83).toFixed(3)) });
            emitB(net, [[rise.x, rise.y], padAt(`U${Q.cells[0]}`, '1')]);
            return routeNet(net, padAt(sr, '14'), [drop.x, drop.y], { startVia: drop,
              guide: [[62.3, 68.7], [62.1, 69.4], [61.8, 69.9], [61.65, 70.25]] });
          });
          // PWMB_78: pad 15 -> SW hug -> second wedge-east drop -> W78 hug
          // lane (In10) -> row-2/3 band -> rise at the U78 N-slot mouth ->
          // down the slot into U78.5's west face.
          fabNet(`PWMB_${Q.cells[0]}`, () => {
            const net = `PWMB_${Q.cells[0]}`;
            // the drop dodges PWMB_91's rise/tail IMAGES (its band-NN
            // channel work sits one period east-south of this box)
            const drop = findSite([c78x - 2.78, c78y + 3.37], net, c78y + 3.27, c78y + 3.47, c78x - 2.88, c78x - 2.68);
            const jTop = findSite([c78x - 4.07, c78y - 2.753], net, c78y - 2.833, c78y - 2.673, c78x - 4.1, c78x - 4.04);
            const rise = findSite([c78x + 1.42, c78y - 4.33], net, ...bandN);
            if (!drop || !jTop || !rise) { console.error(`FABRIC ${net}: no ${!drop ? 'drop' : !jTop ? 'jTop' : 'rise'} site`); return false; }
            cvias.push({ net, x: drop.x, y: drop.y }, { net, x: jTop.x, y: jTop.y }, { net, x: rise.x, y: rise.y });
            runs.push({ net, layer: FAB_B, pts: [...southIn(drop, HW78), [HW78, +(jTop.y + 0.45).toFixed(3)], [jTop.x, jTop.y]] });
            runs.push({ net, layer: LANE_LAYER, pts: gutterPath(jTop, rise, +(c78y - 4.38).toFixed(3)) });
            const u5 = padAt(`U${Q.cells[0]}`, '5');
            emitB(net, [[rise.x, rise.y], [rise.x, +(c78y - 1.25).toFixed(3)], [+(c78x + 1.42).toFixed(3), u5[1]], [+(u5[0] - 0.45).toFixed(3), u5[1]]]);
            return routeNet(net, padAt(sr, '15'), [drop.x, drop.y], { startVia: drop,
              guide: [[64.6, 70.5], [64.0, 70.6], [63.2, 70.55], [62.6, 70.45]] });
          });
          // DATA_E: pad 2 -> NW hug -> 78|89 valley drop -> row-2/3 band east
          // -> seam-top junction -> internal hug lane SOUTH (In11) ending in
          // a leg ONTO the column-snapped portal barrel.
          fabNet('DATA_E', () => {
            const portalT = taps.find((t2) => t2.net === 'DATA_E' && t2.kind !== 'stub');
            if (!portalT) return false;
            // the drop must sit at x <= 61.0: any site in [61.1,62.9]
            // images one period east into the E79 hug / gutter-diagonal
            // corridor (measured: the old (62.65,63.50) drop's image was the
            // fence-post that sealed PWMB_91's band-N traverse)
            const drop = findSite([c78x - 4.55, c78y - 3.1], 'DATA_E', c78y - 3.2, c78y - 2.95, c78x - 4.63, c78x - 4.48);
            // WEST of the hug with a hard window: every jTop east of it is
            // pinched between the 70.71/71.29 crossovers and whatever rides
            // the hug, and a wandering drop/jTop lands its image on the E79
            // corridor one period over
            const jTop = findSite([HINT - 0.68, c78y - 2.833], 'DATA_E', c78y - 2.933, c78y - 2.733, HINT - 0.88, HINT - 0.48);
            if (!drop || !jTop) { console.error(`FABRIC DATA_E: no ${!drop ? 'drop' : 'jTop'} site`); return false; }
            cvias.push({ net: 'DATA_E', x: drop.x, y: drop.y }, { net: 'DATA_E', x: jTop.x, y: jTop.y });
            runs.push({ net: 'DATA_E', layer: LANE_LAYER, pts: gutterPath(drop, jTop, +(c78y - 2.58).toFixed(3)) });
            runs.push({ net: 'DATA_E', layer: FAB_A, pts: [[jTop.x, jTop.y], [HINT, +(jTop.y + 0.45).toFixed(3)],
              [HINT, +(+portalT.y).toFixed(3)], [portalT.x, portalT.y]] });
            return routeNet('DATA_E', padAt(sr, '2'), [drop.x, drop.y], { startVia: drop,
              guide: [[63.75, 65.3], [63.3, 64.6], [62.85, 63.95], [62.6, 63.4]] });
          });
        }
        // PWMB_78 goes to the router only when the fabric is off: every
        // constructible B.Cu line to U78.5 is an already-claimed corridor,
        // and the router can hop to In12 -- which completed short pocket
        // escapes all sweep long.
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
    if (d < -1e-9) { console.error(`VIOLATION ${s.net} vs ${v.net} portal via at (${v.x},${v.y}): ${d.toFixed(3)} seg (${s.seg.map((q) => q.toFixed(2)).join(',')}) ${s.layer}`); bad++; }
  }
  // fabric layers carry WINDING copper: the hex annulus and that layer's tabs
  if (fabricTabs.has(s.layer)) {
    const need = CLR + W / 2;
    for (const he of hexEdges) {
      if (Math.min(Math.abs(he[0] - s.seg[0]), Math.abs(he[0] - s.seg[2])) > 6 ) continue;
      const d = segSegD(s.seg, he) - need;
      if (segSegD(s.seg, he) < 2 && d < -1e-9) {
        console.error(`VIOLATION ${s.net} ${s.layer} vs winding hex of cell (${he[4].toFixed(1)},${he[5].toFixed(1)}): ${d.toFixed(3)} seg (${s.seg.map((q) => q.toFixed(2)).join(',')})`); bad++;
      }
    }
    for (const [ex, ey] of [[s.seg[0], s.seg[1]], [s.seg[2], s.seg[3]]]) {
      for (const [ccx, ccy] of coils) {
        if (Math.abs(ex - ccx) > 5 || Math.abs(ey - ccy) > 5) continue;
        if (hexDistG(ex - ccx, ey - ccy) < coilKeepRG - 1e-9) {
          console.error(`VIOLATION ${s.net} ${s.layer} endpoint INSIDE winding of cell (${ccx.toFixed(1)},${ccy.toFixed(1)}) seg (${s.seg.map((q) => q.toFixed(2)).join(',')})`); bad++;
        }
      }
    }
    const needT = gPlan.trace / 2 + CLR + W / 2;
    for (const tb of fabricTabs.get(s.layer)) {
      if (Math.min(Math.abs(tb[0] - s.seg[0]), Math.abs(tb[0] - s.seg[2])) > 3) continue;
      const d = segSegD(s.seg, tb) - needT;
      if (segSegD(s.seg, tb) < 2 && d < -1e-9) {
        console.error(`VIOLATION ${s.net} ${s.layer} vs winding tab (${tb[0].toFixed(2)},${tb[1].toFixed(2)}): ${d.toFixed(3)}`); bad++;
      }
    }
  }
}
// constructed vs constructed, per layer, different nets (same BOARD net is
// the same copper and may touch -- except the coil halves, a real short)
for (let i = 0; i < segs.length; i++) {
  for (let j = i + 1; j < segs.length; j++) {
    const a = segs[i], b = segs[j];
    if (a.net === b.net || a.layer !== b.layer) continue;
    if (baseName(a.net) === baseName(b.net) && !baseName(a.net).startsWith('coil_')) continue;
    const d = Math.min(
      ptSeg(a.seg[0], a.seg[1], ...b.seg), ptSeg(a.seg[2], a.seg[3], ...b.seg),
      ptSeg(b.seg[0], b.seg[1], ...a.seg), ptSeg(b.seg[2], b.seg[3], ...a.seg),
    ) - (W + CLR);
    minXNet = Math.min(minXNet, d + W + CLR);
    if (d < -1e-9) { console.error(`VIOLATION ${a.net} x ${b.net} on ${a.layer}: gap ${(d + W + CLR).toFixed(3)} at (${a.seg[0]},${a.seg[1]})-(${a.seg[2]},${a.seg[3]}) vs (${b.seg[0]},${b.seg[1]})-(${b.seg[2]},${b.seg[3]})`); bad++; }
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
