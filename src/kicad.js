// Export the PCB stator as a real .kicad_pcb file -- actual copper spirals on an
// N-layer board, not a picture of one. The board that comes out is the board the
// physics was run on: the coil pitch, trace width, layer count and turns-per-
// layer all come from the same cfg makeStator() reads, so the exported copper
// carries the same current geometry the wrench matrix integrated over.
//
// Two things have to be right, and both are easy to get wrong:
//
//  1. Winding sense. A multilayer spiral is a series stack: current spirals inward
//     on one layer, drops to the next, spirals back out. If the outward layer
//     winds the opposite way round, its field OPPOSES the layer above and the two
//     cancel. Every layer here traverses its corners in the same rotational order
//     (CCW seen from +z) regardless of spiralling in or out, so the fields add.
//
//  2. Via technology. This follows Carl Bugeja's 12-layer method: the layer stack
//     is stitched with plated THROUGH-HOLES only -- no blind or buried vias -- so
//     the board is a standard stackup any fab can press, not the sequential-
//     lamination job that makes high layer counts explode in cost. The catch is
//     that a through hole shorts every layer it passes, so the series stack cannot
//     share one drill point (that would tie all N layers together). Each layer-to-
//     layer hop gets its OWN site that only its two layers reach, on short tabs,
//     while every other layer is simply absent there. Inner hops live in the
//     centre hole; outer hops and the two terminals live in the gutter just outside
//     the coil, stacked into little via farms for current capacity -- the few-inner
//     / many-outer split Bugeja's own drill files show. The winding footprint is
//     untouched; only otherwise-dead board space is used.
//
// test/kicad.test.mjs checks both: the sign of each layer's enclosed area, and
// that every via spans the full stack (F.Cu..B.Cu).

import { effectiveTrace, pcbTurnsPerLayer } from './coils.js';

/** PCB coil geometry in millimetres, recomputed from cfg so it matches
 *  coils.js exactly (same perLayer formula, same effective trace) without
 *  importing the filament model, whose `inner` is a physics approximation, not
 *  the real trace path. */
export function pcbCoilGeometry(cfg) {
  const { coilPitch, coilFill, pcbTraceWidth, pcbCopperThickness, pcbLayers } = cfg.stator;
  const w = coilPitch * coilFill;
  const eff = effectiveTrace(pcbTraceWidth, pcbCopperThickness);
  const perLayer = pcbTurnsPerLayer(w, eff);
  const halfOut = (w / 2) * 1000;
  const pitch = 2 * eff * 1000;               // trace + equal space
  const halfIn = halfOut - pitch * perLayer;  // small centre hole by construction
  // Corner fillet radius. Rounding the square corners opens a copper-free pocket
  // at each cell corner where an outer layer-crossover via can sit clear of the
  // winding -- and it is a gentler current path than a hard 90°. Capped so it
  // never eats more than a corner of the innermost turn.
  const corner = Math.min(0.8, Math.max(pitch, halfIn * 0.6));
  return {
    w: w * 1000, halfOut, halfIn, pitch, corner,
    turns: perLayer, layers: pcbLayers,
    trace: eff * 1000,
  };
}

// CCW corner of a square of half-size r: index 0..3 walks +y up the right edge
// first, which is counter-clockwise seen from +z. Same order on every layer is
// what keeps the field additive.
function corner(k, r) {
  switch (((k % 4) + 4) % 4) {
    case 0: return [r, -r];
    case 1: return [r, r];
    case 2: return [-r, r];
    default: return [-r, -r];
  }
}

/** Raw square-spiral corner vertices for one layer (before rounding). */
export function spiralVertices(g, layerIndex) {
  const inward = layerIndex % 2 === 0;
  const n = g.turns * 4;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const r = inward ? g.halfOut - (g.pitch / 4) * i : g.halfIn + (g.pitch / 4) * i;
    pts.push(corner(i, r));
  }
  return pts;
}

/** One layer's spiral as an ordered list of primitives: a straight {t:'seg'}
 *  per quarter-turn edge and a fillet {t:'arc'} (true circular arc, start a /
 *  mid m / end b) at each interior corner. One element per feature keeps the
 *  exported file compact, and the corners come out as real arcs -- a gentler
 *  current path, and copper pulled clear of the corner pockets where the outer
 *  crossover vias sit. The ends (corner 0) are left sharp so the hop tabs attach
 *  at (halfOut,-halfOut) / (halfIn,-halfIn). */
export function spiralPath(g, layerIndex) {
  const V = spiralVertices(g, layerIndex);
  // Every corner is rounded, with a radius PROPORTIONAL to that turn's own
  // radius (scale set by the outer corner), so the concentric rounded squares
  // nest self-similarly -- outer turns gently round, inner turns tightly round,
  // constant gap between them. The ends (corner 0) stay sharp for the hop tabs.
  const scale = (g.corner ?? 0) / g.halfOut;
  const prims = [];
  let from = V[0];
  for (let i = 1; i < V.length - 1; i++) {
    const A = V[i - 1], P = V[i], B = V[i + 1];
    const dinx = P[0] - A[0], diny = P[1] - A[1], lin = Math.hypot(dinx, diny);
    const dox = B[0] - P[0], doy = B[1] - P[1], lout = Math.hypot(dox, doy);
    const cr = scale * Math.max(Math.abs(P[0]), Math.abs(P[1]));
    const s = Math.min(cr, lin * 0.5, lout * 0.5);
    if (s < 1e-6 || lin < 1e-9 || lout < 1e-9) { prims.push({ t: 'seg', a: from, b: P }); from = P; continue; }
    const T1 = [P[0] - (dinx / lin) * s, P[1] - (diny / lin) * s];
    const T2 = [P[0] + (dox / lout) * s, P[1] + (doy / lout) * s];
    const m = [0.25 * T1[0] + 0.5 * P[0] + 0.25 * T2[0], 0.25 * T1[1] + 0.5 * P[1] + 0.25 * T2[1]];
    prims.push({ t: 'seg', a: from, b: T1 });
    prims.push({ t: 'arc', a: T1, m, b: T2 });
    from = T2;
  }
  prims.push({ t: 'seg', a: from, b: V[V.length - 1] });
  return prims;
}

/** The spiral flattened to a polyline (arc -> its three sample points). Used by
 *  the winding-sense signed-area test; the exporter draws the arcs directly. */
export function spiralPoints(g, layerIndex) {
  const prims = spiralPath(g, layerIndex);
  const pts = [prims[0].a];
  for (const p of prims) { if (p.t === 'arc') pts.push(p.m); pts.push(p.b); }
  return pts;
}

// Canonical KiCad copper-layer name for copper index j of an N-layer board:
// F.Cu is ordinal 0, B.Cu is always ordinal 31, inner layers are In1..In(N-2).
function cuName(j, N) {
  if (j === 0) return 'F.Cu';
  if (j === N - 1) return 'B.Cu';
  return `In${j}.Cu`;
}
function cuOrdinal(j, N) {
  if (j === 0) return 0;
  if (j === N - 1) return 31;
  return j;
}

const f = (x) => (Math.round(x * 1e6) / 1e6).toString();

// Which end of an edge layer is the free one (the terminal). Layer 0's inner end
// always goes to junction 0 (an inner hop), so its outer end is free. Layer N-1's
// free end is whichever end its last junction (N-2) did not consume.
function freeEndIsOuter(layer, N) {
  if (layer === 0) return true;
  return (N - 2) % 2 === 0; // last junction inner -> uses inner end -> outer free
}

/** Plan every through-hole for one coil, in coil-local millimetres. The layer
 *  stack is stitched so that INNER crossovers sit in the small centre hole (they
 *  cannot be routed out past the winding) and OUTER crossovers sit in the four
 *  rounded-corner pockets -- the copper-free triangles the fillets open at each
 *  cell corner -- distributed round-robin, with the tab routed from the coil's
 *  outer end around the perimeter gutter. Returns tab segments (tagged by layer),
 *  crossover vias, terminal stubs, terminal mating vias, and counts. */
export function viaPlan(g, N, cellHalf, viaSize) {
  const P_in = corner(0, g.halfIn);            // every inner end lands here
  const P_out = corner(0, g.halfOut);          // every outer end lands here
  const holeR = Math.max(g.halfIn * 0.58, viaSize * 0.7);   // inner-via radius
  const gutR = g.halfOut + Math.min(g.corner * 0.5,
    Math.max(cellHalf - g.halfOut, viaSize) * 0.55);        // perimeter tab radius
  const step = viaSize * 1.5;                   // via spread inside a corner pocket

  const segments = [];                          // [x0,y0,x1,y1, layer]
  const vias = [];                              // {p:[x,y], layers:[..]} crossovers
  const terminals = [];                         // [x0,y0,x1,y1, layer]
  const termVias = [];                          // {p:[x,y], layers:[l]} mating vias

  const innerJ = [], outerJ = [];
  for (let j = 0; j < N - 1; j++) (j % 2 === 0 ? innerJ : outerJ).push(j);

  // Inner hops: one via each at a UNIQUE angle around the centre hole, reached by
  // the same trick the outer hops use -- a ring from the inner end that stays
  // OUTSIDE all the vias (but still inside the winding) and only dives in to its
  // own. So no hop tab crosses another hop's via.
  const aIn = Math.atan2(P_in[1], P_in[0]);      // the inner end's angle (corner 0)
  const rInVia = Math.min(holeR, g.halfIn - viaSize * 2.2);   // via ring, in the hole
  const rInTab = rInVia + viaSize * 1.0;                       // tab ring, just outside
  const polC = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  innerJ.forEach((j, k) => {
    const ang = aIn + (2 * Math.PI * (k + 1)) / (innerJ.length + 1);
    const site = polC(rInVia, ang);
    const path = [P_in];
    let d = ((ang - aIn) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const dir = d <= Math.PI ? 1 : -1; if (dir < 0) d = 2 * Math.PI - d;
    const steps = Math.max(1, Math.ceil(d / 0.25));
    for (let q = 0; q <= steps; q++) { const aa = aIn + dir * d * (q / steps); path.push(polC(rInTab, aa)); }
    path.push(site);
    for (const layer of [j, j + 1])
      for (let q = 0; q < path.length - 1; q++)
        segments.push([path[q][0], path[q][1], path[q + 1][0], path[q + 1][1], layer]);
    vias.push({ p: site, layers: [j, j + 1] });
  });

  // Outer hops + terminals each get a UNIQUE ANGLE around the perimeter (not
  // stacked in the corners). The tab runs a ring just outside the winding at
  // radius rTab from the coil's outer end round to its angle, then dives OUT to
  // its via at rVia > rTab. Because every via is at a distinct angle and the ring
  // stays inside all of them, no tab ever grazes another via -- the exact
  // wrong-layer short the corner-stacking otherwise caused. validatePcb proves it.
  const a0 = Math.atan2(P_out[1], P_out[0]);     // the outer end's angle (corner 0)
  // The winding is a square, so its boundary radius grows toward the corners.
  // The ring and the vias FOLLOW that boundary (offset out), so a via is always
  // just outside the copper at its own angle instead of buried in a corner.
  const bound = (a) => g.halfOut / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)), 1e-6);
  const cellBound = (a) => cellHalf / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)), 1e-6);
  const rTabAt = (a) => bound(a) + viaSize * 0.7;
  const rViaAt = (a) => Math.min(bound(a) + viaSize * 1.9, cellBound(a) - viaSize * 0.55);
  const pol = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const items = outerJ.map((j) => ({ layers: [j, j + 1], kind: 'hop' }));
  [0, N - 1].filter((l) => freeEndIsOuter(l, N)).forEach((l) => items.push({ layers: [l], kind: 'term' }));
  // Spread over the full circle, skipping a slot at the outer end so the ring
  // always starts clear.
  const M = items.length;
  items.forEach((it, i) => {
    const ang = a0 + (2 * Math.PI * (i + 1)) / (M + 1);
    const via = pol(rViaAt(ang), ang);
    const path = [P_out];
    let d = ((ang - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const dir = d <= Math.PI ? 1 : -1; if (dir < 0) d = 2 * Math.PI - d;
    const steps = Math.max(1, Math.ceil(d / 0.25));
    for (let q = 0; q <= steps; q++) { const aa = a0 + dir * d * (q / steps); path.push(pol(rTabAt(aa), aa)); }
    path.push(via);
    const bucket = it.kind === 'hop' ? segments : terminals;
    for (const layer of it.layers)
      for (let q = 0; q < path.length - 1; q++)
        bucket.push([path[q][0], path[q][1], path[q + 1][0], path[q + 1][1], layer]);
    (it.kind === 'hop' ? vias : termVias).push({ p: via, layers: it.layers });
  });
  // Odd-N corner case: an inner free end just stubs into the hole.
  for (const layer of [0, N - 1]) if (!freeEndIsOuter(layer, N)) terminals.push([P_in[0], P_in[1], 0, 0, layer]);

  return {
    segments, vias, terminals, termVias,
    counts: { inner: innerJ.length, outer: outerJ.length, perCoil: vias.length + termVias.length },
  };
}

/** A self-contained SVG of ONE coil, for an in-app preview -- so the layout (and
 *  any wrong-layer via contacts) can be seen without opening KiCad. Draws two
 *  representative layers' spirals, every crossover/terminal via, and rings any
 *  via that validatePcb flags in red. Returns { svg, stats }. */
export function coilPreviewSVG(cfg) {
  const g = pcbCoilGeometry(cfg);
  const N = cfg.stator.pcbLayers;
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const plan = viaPlan(g, N, cellHalf, via);
  const contacts = validatePcb(g, N, cellHalf, via);
  const badKey = new Set(contacts.map((c) => c.via.map((n) => n.toFixed(3)).join(',')));

  const P = (p) => `${(p[0]).toFixed(3)},${(-p[1]).toFixed(3)}`; // flip y for SVG
  // A distinct colour per layer (ordered hue ramp), so adjacent layers -- the
  // ones a crossover joins -- read as neighbours.
  const col = (j) => `hsl(${Math.round((j / Math.max(N - 1, 1)) * 300)}, 80%, 62%)`;
  const poly = (pts, stroke, w, op) =>
    `<polyline points="${pts.map(P).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w.toFixed(3)}" opacity="${op}" stroke-linejoin="round" stroke-linecap="round"/>`;
  const parts = [];
  // Cell boundary.
  parts.push(`<rect x="${-cellHalf}" y="${-cellHalf}" width="${2 * cellHalf}" height="${2 * cellHalf}" fill="none" stroke="#8884" stroke-width="0.05" stroke-dasharray="0.3 0.2"/>`);
  // EVERY layer's spiral, faint and colour-coded (they stack in Z, so the spirals
  // overlap in this top view -- what differs per layer is where it breaks out to
  // its crossover vias).
  for (let j = 0; j < N; j++) parts.push(poly(spiralPoints(g, j), col(j), g.trace * 0.8, 0.5));
  // Every layer's crossover tabs, full strength -- so each via shows the TWO
  // coloured tabs (its two layers) meeting at it. This is the connectivity.
  for (const [x0, y0, x1, y1, layer] of plan.segments) parts.push(poly([[x0, y0], [x1, y1]], col(layer), g.trace, 1));
  for (const [x0, y0, x1, y1, layer] of plan.terminals)
    if (isFinite(x1) && (x0 !== x1 || y0 !== y1)) parts.push(poly([[x0, y0], [x1, y1]], col(layer), g.trace, 1));
  // Vias: neutral outline so the coloured tabs read through, red if flagged.
  const dot = (p, r) => {
    const bad = badKey.has(p.map((n) => n.toFixed(3)).join(','));
    return `<circle cx="${p[0].toFixed(3)}" cy="${(-p[1]).toFixed(3)}" r="${r}" fill="#0b0e14" stroke="${bad ? '#ff3b3b' : '#e8ecf4'}" stroke-width="0.06"/>`
      + (bad ? `<circle cx="${p[0].toFixed(3)}" cy="${(-p[1]).toFixed(3)}" r="${(r * 2.2).toFixed(3)}" fill="none" stroke="#ff3b3b" stroke-width="0.08"/>` : '');
  };
  for (const v of [...plan.vias, ...plan.termVias]) parts.push(dot(v.p, via / 2));

  const m = cellHalf * 1.08;
  const svg = `<svg viewBox="${-m} ${-m} ${2 * m} ${2 * m}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#0b0e14;border-radius:6px">${parts.join('')}</svg>`;
  return {
    svg,
    stats: {
      turns: g.turns, layers: N, viasPerCoil: plan.counts.perCoil,
      innerVias: plan.counts.inner, outerVias: plan.counts.outer,
      contacts: contacts.length,
    },
  };
}

// Distance from point p to segment ab, in the plane.
function segDist(a, b, p) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const L2 = abx * abx + aby * aby;
  const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / L2));
  return Math.hypot(a[0] + t * abx - p[0], a[1] + t * aby - p[1]);
}

/** Validate that no plated through-hole touches copper of a layer it must NOT
 *  connect. A through-hole shorts every layer it passes, so each via is only
 *  legal if, on every layer OTHER than the two (or one) it stitches, that layer's
 *  copper stays clear of the via pad. Returns the contacts (empty == clean); each
 *  is {via, layer, clearance} in coil-local mm. This is the check that catches a
 *  crossover accidentally shorting a turn it was routed past. */
export function validatePcb(g, N, cellHalf, viaSize) {
  const plan = viaPlan(g, N, cellHalf, viaSize);
  const contact = viaSize / 2 + g.trace / 2;   // via pad edge meets trace edge
  const feat = Array.from({ length: N }, () => []);
  for (let j = 0; j < N; j++) {
    for (const pr of spiralPath(g, j)) {
      if (pr.t === 'arc') { feat[j].push([pr.a, pr.m]); feat[j].push([pr.m, pr.b]); }
      else feat[j].push([pr.a, pr.b]);
    }
  }
  for (const [x0, y0, x1, y1, layer] of plan.segments) feat[layer].push([[x0, y0], [x1, y1]]);
  for (const [x0, y0, x1, y1, layer] of plan.terminals)
    if (isFinite(x1) && (x0 !== x1 || y0 !== y1)) feat[layer].push([[x0, y0], [x1, y1]]);

  const contacts = [];
  for (const v of [...plan.vias, ...plan.termVias]) {
    for (let m = 0; m < N; m++) {
      if (v.layers.includes(m)) continue;
      let dmin = Infinity;
      for (const [a, b] of feat[m]) { const d = segDist(a, b, v.p); if (d < dmin) dmin = d; }
      if (dmin < contact - 1e-6) contacts.push({ via: v.p, layer: m, clearance: dmin });
    }
  }
  return contacts;
}

// One SMD pad of a footprint on side S ('F' or 'B'), on a given net.
// Coordinates are footprint-relative (mm).
function fpPad(n, px, py, w, h, netNum, netName, S = 'F') {
  return `    (pad "${n}" smd rect (at ${px} ${py}) (size ${w} ${h}) (layers "${S}.Cu" "${S}.Paste" "${S}.Mask") (net ${netNum} "${netName}"))`;
}

/** An integrated H-bridge power stage (VBUS, GND, two outputs, two PWM inputs)
 *  as a ~2 mm footprint at (ox, oy) on side S. `out` gives the two output nets;
 *  when both are the coil net the winding is the bridge's load. */
function emitPowerStage(L, ref, ox, oy, f, S, vbus, gnd, outA, outAn, outB, outBn, pa, pan, pb, pbn) {
  const m = S === 'B' ? ' (justify mirror)' : '';
  L.push(`  (footprint "maglev:HB6" (layer "${S}.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "${ref}" (at 0 -1.35) (layer "${S}.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_text value "HB6" (at 0 1.35) (layer "${S}.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_rect (start -1 -1) (end 1 1) (layer "${S}.CrtYd") (width 0.05))`);
  L.push(fpPad(1, -0.9, -0.65, 0.5, 0.3, vbus, 'VBUS', S));
  L.push(fpPad(2, -0.9, 0, 0.5, 0.3, gnd, 'GND', S));
  L.push(fpPad('3', -0.9, 0.65, 0.5, 0.3, outA, outAn, S));
  L.push(fpPad('4', 0.9, -0.65, 0.5, 0.3, outB, outBn, S));
  L.push(fpPad('5', 0.9, 0, 0.5, 0.3, pa, pan, S));
  L.push(fpPad('6', 0.9, 0.65, 0.5, 0.3, pb, pbn, S));
  L.push('  )');
}

/** A 0402 decoupling cap across VBUS/GND on side S. */
function emitDecap(L, ref, ox, oy, f, S, vbus, gnd) {
  const m = S === 'B' ? ' (justify mirror)' : '';
  L.push(`  (footprint "maglev:C0402" (layer "${S}.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "${ref}" (at 0 -0.6) (layer "${S}.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
  L.push(`    (fp_text value "100n" (at 0 0.6) (layer "${S}.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
  L.push(`    (fp_rect (start -0.55 -0.35) (end 0.55 0.35) (layer "${S}.CrtYd") (width 0.05))`);
  L.push(fpPad(1, -0.5, 0, 0.4, 0.5, vbus, 'VBUS', S));
  L.push(fpPad(2, 0.5, 0, 0.4, 0.5, gnd, 'GND', S));
  L.push('  )');
}

/** Build the driver backplane: a 2-layer board that mates to the passive coil
 *  board and carries the amplifier array. One H-bridge per coil (outputs to two
 *  mating vias placed at that coil's terminal pockets, so the winding on the
 *  other board is the bridge's load), a decoupling cap, shared VBUS/GND copper
 *  pours, and a per-coil PWM pair. Returns { text, stats } or null for non-PCB. */
export function buildDriverBackplane(stator, cfg) {
  if (cfg.stator.coilType !== 'pcb') return null;
  const N = cfg.stator.pcbLayers;
  const g = pcbCoilGeometry(cfg);
  const S = cfg.stator.statorSize * 1000;
  const cx0 = S / 2 + 10, cy0 = S / 2 + 10;
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const plan = viaPlan(g, N, cellHalf, via);
  const C = stator.coils.length;

  const netGND = 1, netVBUS = 2;
  const oA = (i) => 3 + 4 * i, oB = (i) => 3 + 4 * i + 1, pA = (i) => 3 + 4 * i + 2, pB = (i) => 3 + 4 * i + 3;

  const L = [];
  L.push('(kicad_pcb (version 20221018) (generator "maglev-sim")');
  L.push('  (general (thickness 1.6))');
  L.push('  (paper "A3")');
  L.push('  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))');
  L.push('  (setup (pad_to_mask_clearance 0))');
  L.push('  (net 0 "")');
  L.push(`  (net ${netGND} "GND")`);
  L.push(`  (net ${netVBUS} "VBUS")`);
  for (let i = 0; i < C; i++) {
    L.push(`  (net ${oA(i)} "OUTA_${i}")`);
    L.push(`  (net ${oB(i)} "OUTB_${i}")`);
    L.push(`  (net ${pA(i)} "PWMA_${i}")`);
    L.push(`  (net ${pB(i)} "PWMB_${i}")`);
  }

  const edge = [[-S / 2, -S / 2], [S / 2, -S / 2], [S / 2, S / 2], [-S / 2, S / 2]];
  for (let e = 0; e < 4; e++) {
    const a = edge[e], b = edge[(e + 1) % 4];
    L.push(`  (gr_line (start ${f(cx0 + a[0])} ${f(cy0 + a[1])}) (end ${f(cx0 + b[0])} ${f(cy0 + b[1])}) (layer "Edge.Cuts") (width 0.1))`);
  }

  // Power planes: GND pour on the back, VBUS pour on the front, both over the
  // whole board -- the room a 2-layer backplane has and the coil board does not.
  const zone = (net, name, layer) => {
    L.push(`  (zone (net ${net}) (net_name "${name}") (layer "${layer}") (hatch edge 0.5) (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.4))`);
    L.push('    (polygon (pts ' + edge.map((p) => `(xy ${f(cx0 + p[0])} ${f(cy0 + p[1])})`).join(' ') + '))');
    L.push('  )');
  };
  zone(netGND, 'GND', 'B.Cu');
  zone(netVBUS, 'VBUS', 'F.Cu');

  let drivers = 0, decaps = 0, mating = 0;
  for (let ci = 0; ci < C; ci++) {
    const c = stator.coils[ci];
    const ox = cx0 + c.x * 1000, oy = cy0 - c.y * 1000;
    const tx = (p0) => f(ox + p0), ty = (p1) => f(oy + p1);
    // The H-bridge sits at the coil centre (mates over the coil's hole), cap beside it.
    emitPowerStage(L, `U${ci}`, ox, oy, f, 'F', netVBUS, netGND, oA(ci), `OUTA_${ci}`, oB(ci), `OUTB_${ci}`, pA(ci), `PWMA_${ci}`, pB(ci), `PWMB_${ci}`);
    emitDecap(L, `C${ci}`, ox + 1.7, oy, f, 'F', netVBUS, netGND);
    drivers++; decaps++;
    // Mating vias at the coil's two terminal pockets, on the bridge outputs, so
    // the connector picks up each coil end. Route the output pad to its via.
    const outNets = [oA(ci), oB(ci)];
    plan.termVias.forEach(({ p: tv }, k) => {
      const net = outNets[k % 2];
      L.push(`  (via (at ${tx(tv[0])} ${ty(tv[1])}) (size ${f(via)}) (drill ${f(drill)}) (layers "F.Cu" "B.Cu") (net ${net}))`);
      const pad = k % 2 === 0 ? [-0.9, 0.65] : [0.9, -0.65]; // OUTA / OUTB pad
      L.push(`  (segment (start ${tx(pad[0])} ${ty(pad[1])}) (end ${tx(tv[0])} ${ty(tv[1])}) (width ${f(g.trace)}) (layer "F.Cu") (net ${net}))`);
      mating++;
    });
  }
  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      drivers, decaps, mating, layers: 2, coils: C, boardMm: S,
      driverTopology: 'H-bridge per coil (independent)',
      nets: 2 + 4 * C,
    },
  };
}

/** Build a complete .kicad_pcb for the PCB stator. Returns { text, stats } or
 *  null when the coil type is not a PCB (nothing to fabricate as copper). */
export function buildKiCad(stator, cfg) {
  if (cfg.stator.coilType !== 'pcb') return null;

  const N = cfg.stator.pcbLayers;
  const g = pcbCoilGeometry(cfg);
  const S = cfg.stator.statorSize * 1000;             // board edge, mm
  const cx0 = S / 2 + 10, cy0 = S / 2 + 10;           // keep all coords positive
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const plan = viaPlan(g, N, cellHalf, via);
  const thVia = [cuName(0, N), cuName(N - 1, N)];      // full-stack through-hole

  // --- header + layer stackup ---
  const L = [];
  L.push('(kicad_pcb (version 20221018) (generator "maglev-sim")');
  L.push(`  (general (thickness ${f(stator.thickness * 1000)}))`);
  L.push('  (paper "A3")');
  L.push('  (layers');
  for (let j = 0; j < N; j++) L.push(`    (${cuOrdinal(j, N)} "${cuName(j, N)}" signal)`);
  L.push('    (44 "Edge.Cuts" user)');
  L.push('  )');
  L.push('  (setup (pad_to_mask_clearance 0))');

  // --- nets: one signal net per coil ---
  // The coil board is now PASSIVE and dense: the drivers live on a mating
  // backplane (buildDriverBackplane), so every layer here is coil copper and the
  // only nets are the coils themselves. Each coil's two terminals surface as
  // mating vias in opposite corner pockets for the backplane's connector.
  const C = stator.coils.length;
  L.push('  (net 0 "")');
  stator.coils.forEach((_, i) => L.push(`  (net ${i + 1} "coil_${i}")`));

  // --- board outline ---
  const edge = [[-S / 2, -S / 2], [S / 2, -S / 2], [S / 2, S / 2], [-S / 2, S / 2]];
  for (let e = 0; e < 4; e++) {
    const a = edge[e], b = edge[(e + 1) % 4];
    L.push(`  (gr_line (start ${f(cx0 + a[0])} ${f(cy0 + a[1])}) (end ${f(cx0 + b[0])} ${f(cy0 + b[1])}) (layer "Edge.Cuts") (width 0.1))`);
  }

  // --- coils ---
  let segments = 0, vias = 0;
  const layerPath = Array.from({ length: N }, (_, j) => spiralPath(g, j));
  for (let ci = 0; ci < stator.coils.length; ci++) {
    const c = stator.coils[ci];
    const net = ci + 1;
    // Sim centres are metres, board centred on origin; flip y for KiCad's
    // y-down page so the exported array reads the same way up as the render.
    const ox = cx0 + c.x * 1000, oy = cy0 - c.y * 1000;
    const tx = (p0) => f(ox + p0);
    const ty = (p1) => f(oy + p1);

    // The spiral tracks, layer by layer: straight edges and arc corners.
    for (let j = 0; j < N; j++) {
      const layer = cuName(j, N);
      for (const p of layerPath[j]) {
        if (p.t === 'arc') {
          L.push(`  (arc (start ${tx(p.a[0])} ${ty(p.a[1])}) (mid ${tx(p.m[0])} ${ty(p.m[1])}) (end ${tx(p.b[0])} ${ty(p.b[1])}) (width ${f(g.trace)}) (layer "${layer}") (net ${net}))`);
        } else {
          L.push(`  (segment (start ${tx(p.a[0])} ${ty(p.a[1])}) (end ${tx(p.b[0])} ${ty(p.b[1])}) (width ${f(g.trace)}) (layer "${layer}") (net ${net}))`);
        }
        segments++;
      }
    }

    // Through-hole stitching: tabs (each on its own layer) + full-stack vias.
    for (const [x0, y0, x1, y1, layer] of plan.segments) {
      L.push(`  (segment (start ${tx(x0)} ${ty(y0)}) (end ${tx(x1)} ${ty(y1)}) (width ${f(g.trace)}) (layer "${cuName(layer, N)}") (net ${net}))`);
      segments++;
    }
    for (const { p: [x, y] } of plan.vias) {
      L.push(`  (via (at ${tx(x)} ${ty(y)}) (size ${f(via)}) (drill ${f(drill)}) (layers "${thVia[0]}" "${thVia[1]}") (net ${net}))`);
      vias++;
    }
    // Terminal stubs to the corner pockets, and a mating via at each so the
    // backplane connector can pick the two coil ends up.
    for (const [x0, y0, x1, y1, layer] of plan.terminals) {
      L.push(`  (segment (start ${tx(x0)} ${ty(y0)}) (end ${tx(x1)} ${ty(y1)}) (width ${f(g.trace)}) (layer "${cuName(layer, N)}") (net ${net}))`);
      segments++;
    }
    for (const { p: [x, y] } of plan.termVias) {
      L.push(`  (via (at ${tx(x)} ${ty(y)}) (size ${f(via)}) (drill ${f(drill)}) (layers "${thVia[0]}" "${thVia[1]}") (net ${net}))`);
      vias++;
    }
  }

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      coils: stator.coils.length, layers: N, turnsPerLayer: g.turns,
      segments, vias, viasPerCoil: plan.counts.perCoil,
      innerVias: plan.counts.inner, outerVias: plan.counts.outer,
      viaTech: 'through-hole (plated)', cornerVias: true,
      nets: stator.coils.length, boardMm: S, traceMm: g.trace,
      drivers: 0, driverTopology: 'backplane (separate board)',
    },
  };
}
