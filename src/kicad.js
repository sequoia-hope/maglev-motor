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

import { effectiveTrace, pcbTurnsPerLayer, makeStator, isPcbCoil } from './coils.js';

/** PCB coil geometry in millimetres, recomputed from cfg so it matches
 *  coils.js exactly (same perLayer formula, same effective trace) without
 *  importing the filament model, whose `inner` is a physics approximation, not
 *  the real trace path. */
export function pcbCoilGeometry(cfg) {
  const { coilPitch, coilFill, pcbTraceWidth, pcbCopperThickness, pcbLayers, coilType } = cfg.stator;
  // Spare layers carry electronics, not winding (see coils.js): the board is
  // pressed at pcbLayers but only the top (pcbLayers - spare) wind. g.layers is
  // the WINDING count -- everything that plans spirals and crossovers keys off
  // it -- while g.physLayers names the physical stackup the fab presses.
  const spare = cfg.stator.pcbSpareLayers || 0;
  const windLayers = Math.max(1, pcbLayers - spare);
  const w = coilPitch * coilFill;
  const eff = effectiveTrace(pcbTraceWidth, pcbCopperThickness);
  const perLayer = pcbTurnsPerLayer(w, eff);
  const halfOut = (w / 2) * 1000;             // apothem (centre-to-flat) of the outermost turn
  const pitch = 2 * eff * 1000;               // trace + equal space
  const halfIn = halfOut - pitch * perLayer;  // small centre hole by construction
  // Coil outline: a square (4 sides) or, for the honeycomb topology, a pointy-top
  // hexagon (6 sides). Both are wound in APOTHEM space -- halfOut/halfIn are the
  // centre-to-flat depths -- so the turns-from-layers count is identical; only the
  // vertex count and orientation differ. The square keeps its original phase so
  // its exported copper is byte-for-byte unchanged.
  const sides = coilType === 'pcbhex' ? 6 : 4;
  const phase = sides === 6 ? 0 : -Math.PI / 2;
  // Corner fillet radius. Rounding the corners opens a copper-free pocket at each
  // cell corner where an outer layer-crossover via can sit clear of the winding --
  // and it is a gentler current path than a hard corner. Capped so it never eats
  // more than a corner of the innermost turn.
  const corner = Math.min(0.8, Math.max(pitch, halfIn * 0.6));
  return {
    w: w * 1000, halfOut, halfIn, pitch, corner, sides, phase,
    turns: perLayer, layers: windLayers, physLayers: pcbLayers,
    trace: eff * 1000,
  };
}

// One CCW vertex of a regular polygon inscribed at apothem `a` (centre-to-flat).
// Index walks CCW seen from +z; the same walk order on every layer is what keeps
// the field additive. `sides`/`phase` pick square vs hexagon and its orientation:
// sides=4, phase=-pi/2 reproduces the original square corners (r,-r),(r,r),... to
// the bit; sides=6, phase=0 is a pointy-top hexagon.
function polyCorner(k, a, sides, phase) {
  const R = a / Math.cos(Math.PI / sides);       // apothem -> circumradius
  const kk = ((k % sides) + sides) % sides;
  const ang = phase + (kk + 0.5) * (2 * Math.PI / sides);
  return [R * Math.cos(ang), R * Math.sin(ang)];
}

// Edges (corner-to-corner steps) per layer. A whole number of TURNS would land
// every layer's ends on the same corner, forcing every crossover into one spot
// and long ring tabs. Adding sides/(N-1) of an edge walks each layer's ends
// 360/(N-1) deg further round than the last, so the N-1 crossovers spread evenly
// around the coil and each one sits right at its layers' shared endpoint -- a
// short radial stub, never a tab that rings around.
function edgeTurns(g) {
  const s = g.sides ?? 4;
  return s * g.turns + s / Math.max(g.layers - 1, 1);
}

/** Raw spiral corner vertices for one layer (before rounding). Each layer starts
 *  a little further round than the last, so the layers' shared ends fan out
 *  around the coil instead of stacking on one corner. Square or hexagon per
 *  g.sides/g.phase. */
export function spiralVertices(g, layerIndex) {
  const sides = g.sides ?? 4, phase = g.phase ?? -Math.PI / 2;
  const q = edgeTurns(g);
  const u0 = layerIndex * q, u1 = u0 + q;
  const inward = layerIndex % 2 === 0;
  const step = g.pitch / sides;                  // radial advance per edge
  const rAt = (u) => Math.max(g.halfIn, Math.min(g.halfOut,
    inward ? g.halfOut - step * (u - u0) : g.halfIn + step * (u - u0)));
  const pt = (u) => {
    const k = Math.floor(u + 1e-9), t = u - k, r = rAt(u);
    const a = polyCorner(k, r, sides, phase), b = polyCorner(k + 1, r, sides, phase);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const pts = [pt(u0)];
  for (let k = Math.floor(u0) + 1; k < u1 - 1e-9; k++) pts.push(pt(k));
  pts.push(pt(u1));
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
    // Fillet radius proportional to this turn's radius, so the concentric rounded
    // rings nest self-similarly. For the square, the turn radius is the apothem
    // max(|x|,|y|) (keeps the original output exactly); for other polygons it is
    // the vertex distance.
    const turnR = (g.sides ?? 4) === 4 ? Math.max(Math.abs(P[0]), Math.abs(P[1])) : Math.hypot(P[0], P[1]);
    const cr = scale * turnR;
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

/** Plan every through-hole for one coil, in coil-local millimetres. Because the
 *  spiral ends now fan out around the coil (see spiralVertices), each crossover
 *  sits right at the shared endpoint of its two layers: the via is that endpoint
 *  nudged just off the winding (inward for an inner end, outward for an outer
 *  one) and the tab is a SHORT RADIAL STUB -- no ring, no backtrack. Returns tab
 *  segments (tagged by layer), crossover vias, terminal stubs, terminal mating
 *  vias, and counts. */
export function viaPlan(g, N, cellHalf, viaSize) {
  const off = viaSize * 1.05;                    // radial stub length off the winding
  const segments = [];                           // [x0,y0,x1,y1, layer]
  const vias = [];                               // {p, layers} crossovers
  const terminals = [];                          // [x0,y0,x1,y1, layer]
  const termVias = [];                           // {p, layers} mating vias

  // Nudge a boundary point p radially: outward into the gutter, or inward into
  // the centre hole. Inner vias are pulled all the way inside the innermost turn
  // (radius <= halfIn - off) so an endpoint that lands near a corner still ends up
  // in the clear hole, not crowded against the corner copper.
  const nudge = (p, outward) => {
    const r = Math.hypot(p[0], p[1]) || 1;
    const rNew = outward ? r + off : Math.min(r - off, g.halfIn - off);
    return [p[0] * (rNew / r), p[1] * (rNew / r)];
  };

  // Crossover c joins layer c and c+1 at their shared endpoint. c even = inner
  // end (nudge into the centre hole), c odd = outer end (nudge into the gutter).
  for (let c = 0; c < N - 1; c++) {
    const end = spiralVertices(g, c);
    const p = end[end.length - 1];
    const via = nudge(p, c % 2 === 1);           // outer crossover pushes out
    for (const layer of [c, c + 1]) segments.push([p[0], p[1], via[0], via[1], layer]);
    vias.push({ p: via, layers: [c, c + 1] });
  }

  // Terminals -> SMT pads. Each coil lead (layer 0's start, layer N-1's end) is
  // brought by a short gutter stub to a rectangular pad in its NEAREST corner
  // pocket, where the fillet has pulled the winding in and left room clear of the
  // copper and the neighbours. The pad is sized to that clear band. validatePcb
  // checks it touches nothing but its own via and stub.
  // Terminals -> SMT pads. Like the crossovers, each lead drops STRAIGHT out from
  // its own end (a short radial stub, never routed across other vias) to a pad on
  // the cell boundary. The gutter is thin ACROSS (radial) but long ALONG the
  // boundary (tangential), so the pad is a rectangle rotated to the boundary --
  // thin radially (fits the shared inter-coil gutter, clear of both windings) and
  // long tangentially. Both leads get the SAME size, the pad swallowing its own
  // short stub. Rotation `a` is the outward radial direction.
  const termPads = [];                           // {p, layer, w, h, a}
  const s0 = spiralVertices(g, 0)[0];
  const eN = spiralVertices(g, N - 1); const pN = eN[eN.length - 1];
  const sides = g.sides ?? 4;
  if (sides === 6) {
    // Honeycomb: the square-cell trick below pushes the pad onto a boundary that
    // is NOT where the neighbouring hexes are, so the pad can land inside a
    // neighbour. Instead centre each pad on its mating via -- a short radial nudge
    // off the winding end -- align it to the nearest hex edge (its long axis runs
    // ALONG that flat), and shrink it until it sits entirely inside THIS coil's own
    // honeycomb cell (apothem = cellHalf, flats at 0,60,...deg). A pad inside its
    // own cell cannot reach a neighbour, because the cells tile without overlap.
    const flats = [0, 1, 2, 3, 4, 5].map((k) => (k * Math.PI) / 3);
    const off = viaSize * 1.05, margin = viaSize / 2 + g.trace;
    for (const [p, layer] of [[s0, 0], [pN, N - 1]]) {
      // Work in the frame of the nearest hex EDGE: `n` is that flat's outward
      // normal, `t` runs along the edge. The outer winding ends sit near the coil
      // vertices, so a plain radial nudge overshoots the cell; instead push out
      // along `n` just past the winding but capped inside the cell, and clamp the
      // along-edge position so the pad sits within the wedge the two adjacent
      // flats leave -- entirely inside this coil's own cell.
      const raw = Math.atan2(p[1], p[0]);
      const fa = flats.reduce((best, fk) =>
        (Math.abs(((raw - fk + Math.PI) % (2 * Math.PI)) - Math.PI)
          < Math.abs(((raw - best + Math.PI) % (2 * Math.PI)) - Math.PI) ? fk : best), flats[0]);
      const n = [Math.cos(fa), Math.sin(fa)], t = [-Math.sin(fa), Math.cos(fa)];
      const pt = p[0] * t[0] + p[1] * t[1];
      // Sit the via in the middle of the flat gutter: outside the winding flat
      // (at apothem halfOut) and inside the cell flat (at cellHalf).
      const mid = (g.halfOut + cellHalf) / 2;
      const rVia = Math.min(cellHalf - margin, Math.max(g.halfOut + off, mid));
      // Stay over the FLAT, clear of the vertex bulge: cap the along-edge offset
      // by both the winding flat's half-length and the cell's width here.
      const tWind = g.halfOut * Math.tan(Math.PI / 6);
      const tCell = (cellHalf - 0.5 * rVia) / (Math.sqrt(3) / 2);
      const tLim = Math.min(tWind, tCell) - margin;
      const tVia = Math.max(-tLim, Math.min(tLim, pt));
      const via = [n[0] * rVia + t[0] * tVia, n[1] * rVia + t[1] * tVia];
      // Size: radial half-width limited by the gutter it must not cross into the
      // winding, tangential by the flat; then shrink so every corner is in-cell.
      let w = Math.min(0.4, 2 * (rVia - g.halfOut - margin));
      let h = Math.min(0.8, 2 * (tLim - Math.abs(tVia)) + 0.4);
      let s = 1;
      for (const fk of flats) {
        const m = [Math.cos(fk), Math.sin(fk)];
        const slack = cellHalf - (via[0] * m[0] + via[1] * m[1]);
        const need = (w / 2) * Math.abs(n[0] * m[0] + n[1] * m[1])
          + (h / 2) * Math.abs(t[0] * m[0] + t[1] * m[1]);
        if (need > 1e-9) s = Math.min(s, Math.max(0, slack) / need);
      }
      w = Math.max(0.15, w * s); h = Math.max(0.15, h * s);
      terminals.push([p[0], p[1], via[0], via[1], layer]);
      termVias.push({ p: via, layers: [layer] });
      termPads.push({ p: via, layer, w, h, a: fa });
    }
  } else {
    // Square grid: each lead drops straight out to a pad on the shared cell
    // boundary -- thin radially (fits the inter-coil gutter), long tangentially.
    const terms = [[s0, 0], [pN, N - 1]].map(([p, layer]) => {
      const r = Math.hypot(p[0], p[1]) || 1, a = Math.atan2(p[1], p[0]);
      const cb = cellHalf / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)), 1e-6);
      return { p, layer, r, a, cb, gut: cb - r };
    });
    const wRad = Math.max(0.2, Math.min(0.5, 2 * Math.min(...terms.map((t) => t.gut)) - viaSize - g.trace));
    const hTan = Math.min(0.7, 1.9 * g.corner);    // along the boundary; corner room is the limit
    for (const t of terms) {
      const padC = [t.p[0] * t.cb / t.r, t.p[1] * t.cb / t.r];
      terminals.push([t.p[0], t.p[1], padC[0], padC[1], t.layer]);
      termVias.push({ p: padC, layers: [t.layer] });
      termPads.push({ p: padC, layer: t.layer, w: wRad, h: hTan, a: t.a });
    }
  }

  let inner = 0, outer = 0;
  for (let c = 0; c < N - 1; c++) (c % 2 === 0 ? inner++ : outer++);
  return {
    segments, vias, terminals, termVias, termPads,
    counts: { inner, outer, perCoil: vias.length + termVias.length },
  };
}

/** A self-contained SVG of ONE coil, for an in-app preview -- so the layout (and
 *  any wrong-layer via contacts) can be seen without opening KiCad. Draws two
 *  representative layers' spirals, every crossover/terminal via, and rings any
 *  via that validatePcb flags in red. Returns { svg, stats }. */
export function coilPreviewSVG(cfg) {
  const g = pcbCoilGeometry(cfg);
  const N = g.layers;   // winding layers only -- a spare electronics layer has no spiral to draw
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
  // Cell boundary: a square cell for the grid, a hexagon for the honeycomb (drawn
  // at the cell apothem = half the coil pitch, same orientation as the coil).
  if ((g.sides ?? 4) === 6) {
    const hex = Array.from({ length: 6 }, (_, k) => polyCorner(k, cellHalf, 6, g.phase)).map(P).join(' ');
    parts.push(`<polygon points="${hex}" fill="none" stroke="#8884" stroke-width="0.05" stroke-dasharray="0.3 0.2"/>`);
  } else {
    parts.push(`<rect x="${-cellHalf}" y="${-cellHalf}" width="${2 * cellHalf}" height="${2 * cellHalf}" fill="none" stroke="#8884" stroke-width="0.05" stroke-dasharray="0.3 0.2"/>`);
  }
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
  for (const v of plan.vias) parts.push(dot(v.p, via / 2));
  // I/O SMT pads (on the back) as gold rectangles, rotated to the boundary.
  for (const pad of plan.termPads || []) {
    const deg = (-(pad.a || 0) * 180 / Math.PI).toFixed(1);
    parts.push(`<g transform="translate(${pad.p[0].toFixed(3)},${(-pad.p[1]).toFixed(3)}) rotate(${deg})"><rect x="${(-pad.w / 2).toFixed(3)}" y="${(-pad.h / 2).toFixed(3)}" width="${pad.w.toFixed(3)}" height="${pad.h.toFixed(3)}" rx="0.05" fill="#e0a83c" stroke="#0b0e14" stroke-width="0.04"/></g>`);
  }

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

  // The input/output SMT pads sit on B.Cu (layer N-1). They may touch only their
  // own via and stub -- never a winding turn (the "next coil loop"). Check each
  // pad rectangle against the winding spiral on its layer.
  const bSpiral = [];
  for (const pr of spiralPath(g, N - 1)) {
    if (pr.t === 'arc') { bSpiral.push([pr.a, pr.m]); bSpiral.push([pr.m, pr.b]); }
    else bSpiral.push([pr.a, pr.b]);
  }
  for (const pad of plan.termPads || []) {
    const ca = Math.cos(pad.a || 0), sa = Math.sin(pad.a || 0); // pad's radial axis
    let dmin = Infinity;
    for (const [a, b] of bSpiral) {
      for (let t = 0; t <= 1; t += 0.2) {
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        const dx = x - pad.p[0], dy = y - pad.p[1];
        const lr = dx * ca + dy * sa, lt = -dx * sa + dy * ca;   // into pad frame
        const ex = Math.max(Math.abs(lr) - pad.w / 2, 0), ey = Math.max(Math.abs(lt) - pad.h / 2, 0);
        const d = Math.hypot(ex, ey); if (d < dmin) dmin = d;
      }
    }
    if (dmin < g.trace / 2 - 1e-6) contacts.push({ via: pad.p, layer: N - 1, clearance: dmin, pad: true });
  }

  // Honeycomb only: a pad must stay inside this coil's own hexagonal cell, or it
  // reaches into a neighbouring coil (which the single-coil winding check above
  // cannot see). Test every pad corner against the six cell half-planes.
  if ((g.sides ?? 4) === 6) {
    for (const pad of plan.termPads || []) {
      const ca = Math.cos(pad.a), sa = Math.sin(pad.a);
      const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sy]) => [
        pad.p[0] + sx * (pad.w / 2) * ca - sy * (pad.h / 2) * sa,
        pad.p[1] + sx * (pad.w / 2) * sa + sy * (pad.h / 2) * ca,
      ]);
      let outside = false;
      for (const c of corners) {
        for (let k = 0; k < 6 && !outside; k++) {
          const ang = (k * Math.PI) / 3;
          if (c[0] * Math.cos(ang) + c[1] * Math.sin(ang) > cellHalf + 1e-6) outside = true;
        }
      }
      if (outside) contacts.push({ via: pad.p, layer: N - 1, clearance: 0, pad: true, neighbour: true });
    }
  }
  return contacts;
}

// One SMD pad of a footprint on side S ('F' or 'B'), on a given net.
// Coordinates are footprint-relative (mm). `clr` is a pad-level clearance
// override for land patterns whose own pads sit closer than the netclass
// demands (the WSON exposed pad is 0.1 mm from its perimeter pads by the
// manufacturer's drawing -- that is the part, not a layout mistake).
function fpPad(n, px, py, w, h, netNum, netName, S = 'F', rot = 0, clr = 0) {
  return `    (pad "${n}" smd rect (at ${px} ${py}${rot ? ` ${rot}` : ''}) (size ${w} ${h}) (layers "${S}.Cu" "${S}.Paste" "${S}.Mask")${clr ? ` (clearance ${clr})` : ''} (net ${netNum} "${netName}"))`;
}

/** Emit one part at file position `at`, rotated `rotDeg` (math CCW in the
 *  world y-up frame), with `fp.pads` given in the WORLD frame -- the exact
 *  table the fit search cleared. This is the single place the world -> file
 *  conversion happens: positions rotate in the world frame then negate y
 *  (KiCad files are y-down), while the pad ANGLE passes through unchanged
 *  (KiCad's angle convention is CCW-positive in the y-up sense; both facts
 *  measured off kicad-cli renders, not assumed). The courtyard polygon and
 *  reference text rotate WITH the pads -- a chip drawn at 0 degrees with its
 *  pads swung 120 degrees away is how this bug was first seen.
 *  `nets` maps pad index -> net, in fp.pads order. */
function emitPart(L, { lib, value, ref, S, at, rotDeg, fp, nets, f }) {
  const m = S === 'B' ? ' (justify mirror)' : '';
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const w2f = (px, py) => [px * c - py * s, -(px * s + py * c)];
  const [bx, by] = fp.bodyOff ?? [0, 0];
  const refY = (fp.body[1] / 2 + 0.7);
  L.push(`  (footprint "maglev:${lib}" (layer "${S}.Cu") (at ${f(at[0])} ${f(at[1])})`);
  L.push('    (attr smd)');
  const [tx0, ty0] = w2f(bx, by + refY);
  L.push(`    (fp_text reference "${ref}" (at ${f(tx0)} ${f(ty0)} ${f(rotDeg)}) (layer "${S}.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_text value "${value}" (at ${f(tx0)} ${f(ty0 + 0.8)}) (layer "${S}.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    .map(([sx, sy]) => w2f(bx + (sx * fp.body[0]) / 2, by + (sy * fp.body[1]) / 2));
  L.push(`    (fp_poly (pts ${corners.map(([x, y]) => `(xy ${f(x)} ${f(y)})`).join(' ')}) (layer "${S}.CrtYd") (width 0.05) (fill none))`);
  fp.pads.forEach(([px, py, w, h, clr], k) => {
    const net = nets[k] ?? { num: 0, name: '' };
    const [rx, ry] = w2f(px, py);
    L.push(fpPad(k + 1, f(rx), f(ry), w, h, net.num, net.name, S, f(rotDeg), clr ?? 0));
  });
  L.push('  )');
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


/** A small n×n coil TILE, sized to exactly n coil cells so copies abut into a
 *  seamless larger stator. Same coils, vias, rounded corners and I/O pads as the
 *  full board -- just n² of them, on a board that is n·coilPitch square. Returns
 *  { text, stats } (the coil board) or null for non-PCB. Pair with a same-size
 *  backplane tile. Cheaper to fab and panelise than one giant board. */
export function buildTile(cfg, n = 3, backplane = false) {
  if (!isPcbCoil(cfg.stator.coilType)) return null;
  const tileCfg = { ...cfg, stator: { ...cfg.stator, statorSize: n * cfg.stator.coilPitch } };
  const stator = makeStator({ ...tileCfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  return backplane ? buildDriverBackplane(stator, tileCfg) : buildKiCad(stator, tileCfg);
}

/** Build the driver backplane: a 2-layer board that mates to the passive coil
 *  board and carries the amplifier array. One H-bridge per coil (outputs to two
 *  mating vias placed at that coil's terminal pockets, so the winding on the
 *  other board is the bridge's load), a decoupling cap, shared VBUS/GND copper
 *  pours, and a per-coil PWM pair. Returns { text, stats } or null for non-PCB. */
export function buildDriverBackplane(stator, cfg) {
  if (!isPcbCoil(cfg.stator.coilType)) return null;
  const g = pcbCoilGeometry(cfg);
  const N = g.layers;   // terminal-via positions come from the winding plan
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  // The backplane wears the same self-tileable cell-union outline as the coil
  // board it mates to, so a tiled stator's backplanes tile with it.
  const outline = cellOutline(stator, cfg);
  const half = outline.reduce((a, p) => Math.max(a, Math.abs(p[0]), Math.abs(p[1])), 0);
  const cx0 = half + 10, cy0 = half + 10;
  const plan = viaPlan(g, N, cellHalf, via);
  const C = stator.coils.length;

  const netGND = 1, netVBUS = 2;
  const oA = (i) => 3 + 4 * i, oB = (i) => 3 + 4 * i + 1, pA = (i) => 3 + 4 * i + 2, pB = (i) => 3 + 4 * i + 3;

  // Command-spine nets: the shift chain that DRIVES the PWM nets, its shared
  // clocks, the dead-man, and the header pass-throughs.
  const chain = chainPlan(stator, cfg);
  const M = chain.registers.length;
  const base = 3 + 4 * C;
  const spine = {
    vcc: { num: base, name: 'VLOGIC' },
    sclk: { num: base + 1, name: 'SCLK' },
    rclk: { num: base + 2, name: 'RCLK' },
    oen: { num: base + 3, name: 'OE_N' },
    sync: { num: base + 4, name: 'SYNC' },
    ng: { num: base + 5, name: 'DEADMAN_G' },
    sda: { num: base + 6, name: 'SDA' },
    scl: { num: base + 7, name: 'SCL' },
    gnd: { num: netGND, name: 'GND' },
  };
  const dataNet = (r) => ({ num: base + 8 + r, name: `DATA_${r}` });

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
  for (const k of ['vcc', 'sclk', 'rclk', 'oen', 'sync', 'ng', 'sda', 'scl']) {
    L.push(`  (net ${spine[k].num} "${spine[k].name}")`);
  }
  for (let r = 0; r <= M; r++) L.push(`  (net ${dataNet(r).num} "${dataNet(r).name}")`);

  for (let e = 0; e < outline.length; e++) {
    const a = outline[e], b = outline[(e + 1) % outline.length];
    L.push(`  (gr_line (start ${f(cx0 + a[0])} ${f(cy0 - a[1])}) (end ${f(cx0 + b[0])} ${f(cy0 - b[1])}) (layer "Edge.Cuts") (width 0.1))`);
  }

  // Power planes: GND pour on the back, VBUS pour on the front, both over the
  // whole board -- the room a 2-layer backplane has and the coil board does not.
  const zone = (net, name, layer) => {
    L.push(`  (zone (net ${net}) (net_name "${name}") (layer "${layer}") (hatch edge 0.5) (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.4))`);
    L.push('    (polygon (pts ' + outline.map((p) => `(xy ${f(cx0 + p[0])} ${f(cy0 - p[1])})`).join(' ') + '))');
    L.push('  )');
  };
  zone(netGND, 'GND', 'B.Cu');
  zone(netVBUS, 'VBUS', 'F.Cu');

  // Placement accumulates into `placed` exactly like the single-board plan:
  // bridges and caps first (per cell), then the registers searched clear of
  // them, then dead-man and header -- so nothing lands on anything else. The
  // only per-cell copper here is the two mating vias.
  const obsB = {
    // Same frame flip as backsideObstacles: plan y is file y, planning is y-up.
    discs: plan.termVias.map((v) => ({ x: v.p[0], y: -v.p[1], r: via / 2 })),
    rects: [], cellHalf, offsets: [],
  };
  const CLR = 0.2;
  const placed = [];
  let drivers = 0, decaps = 0, mating = 0, decapsMoved = 0, regsFallback = 0, outSwapped = 0;
  for (let ci = 0; ci < C; ci++) {
    const c = stator.coils[ci];
    const cwx = c.x * 1000, cwy = c.y * 1000;
    const ox = cx0 + cwx, oy = cy0 - cwy;
    const tx = (p0) => f(ox + p0), ty = (p1) => f(oy + p1);
    // Each output pad routes to the NEARER mating via -- a straight run to the
    // parity-assigned one used to slice across the chip's other pads. Swapping
    // the outputs flips the bridge, so the PWM pair swaps WITH them: (IN1,IN2)
    // -> (OUTA,OUTB) is symmetric and the commanded coil polarity is exactly
    // preserved, per-cell, with the swap recorded in the net assignment.
    const padA = [-0.9, 0.65], padB = [0.9, -0.65];          // OUTA / OUTB pads, file frame
    const tv0 = plan.termVias[0].p, tv1 = plan.termVias[1].p;
    const dStraight = Math.hypot(padA[0] - tv0[0], padA[1] - tv0[1]) + Math.hypot(padB[0] - tv1[0], padB[1] - tv1[1]);
    const dSwapped = Math.hypot(padA[0] - tv1[0], padA[1] - tv1[1]) + Math.hypot(padB[0] - tv0[0], padB[1] - tv0[1]);
    const swap = dSwapped < dStraight;         // pad A pairs with the far-parity via
    if (swap) outSwapped++;
    // Outputs keep their own names on their own pads; the swap re-pairs the
    // ROUTING (which via each pad reaches) and compensates the polarity flip
    // by exchanging which PWM net drives IN1 vs IN2.
    const [nPa, nPan, nPb, nPbn] = swap
      ? [pB(ci), `PWMB_${ci}`, pA(ci), `PWMA_${ci}`] : [pA(ci), `PWMA_${ci}`, pB(ci), `PWMB_${ci}`];
    emitPowerStage(L, `U${ci}`, ox, oy, f, 'F', netVBUS, netGND, oA(ci), `OUTA_${ci}`, oB(ci), `OUTB_${ci}`, nPa, nPan, nPb, nPbn);
    placed.push(...partRects(BACKPLANE_FPS.hb6, cwx, cwy, 0));
    // Dogleg stubs to the PAIRED via: exit the pad OUTWARD (clear of the
    // chip's own column), then run straight. Every segment becomes an
    // obstacle, so the decap, registers and service parts route around the
    // copper, not through it.
    const stubs = swap
      ? [[padA, tv1, oA(ci)], [padB, tv0, oB(ci)]]
      : [[padA, tv0, oA(ci)], [padB, tv1, oB(ci)]];
    for (const [pad, tv, net] of stubs) {
      const exit = [pad[0] + Math.sign(pad[0]) * 0.75, pad[1]];
      for (const [a, b] of [[pad, exit], [exit, tv]]) {
        L.push(`  (segment (start ${tx(a[0])} ${ty(a[1])}) (end ${tx(b[0])} ${ty(b[1])}) (width ${f(g.trace)}) (layer "F.Cu") (net ${net}))`);
        // File frame -> world frame for the obstacle list: negate y and angle.
        const mx = cwx + (a[0] + b[0]) / 2, my = cwy - (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        placed.push({ cx: mx, cy: my, w: len + g.trace, h: g.trace, ang: -Math.atan2(b[1] - a[1], b[0] - a[0]) });
      }
    }
    plan.termVias.forEach(({ p: tv }, k) => {
      const net = ((k % 2 === 0) !== swap) ? oA(ci) : oB(ci);
      L.push(`  (via (at ${tx(tv[0])} ${ty(tv[1])}) (size ${f(via)}) (drill ${f(drill)}) (layers "F.Cu" "B.Cu") (net ${net}))`);
      mating++;
    });
    // The cap beside the chip -- searched, not assumed, so it clears the
    // bridge and the stubs by the same margin everything else keeps.
    const dp = placeWorld(BACKPLANE_FPS.c0402, [cwx + 2.2, cwy], stator.coils, obsB, placed, CLR, 1.5, 0.25, [0, Math.PI / 2]);
    const dAt = dp.fits ? dp.at : [cwx + 2.2, cwy];
    if (dp.fits && dp.offMm > 0.01) decapsMoved++;
    // Emitted through the same converter the plan used, so a cap the search
    // stood on end (90 degrees) is DRAWN on end, not flattened back to 0.
    emitPart(L, {
      lib: 'C0402', value: '100n', ref: `C${ci}`, S: 'F',
      at: [cx0 + dAt[0], cy0 - dAt[1]], rotDeg: dp.fits ? dp.rotDeg : 0,
      fp: BACKPLANE_FPS.c0402, nets: [{ num: netVBUS, name: 'VBUS' }, { num: netGND, name: 'GND' }], f,
    });
    placed.push(...partRects(BACKPLANE_FPS.c0402, dAt[0], dAt[1], dp.fits ? (dp.rotDeg * Math.PI) / 180 : 0));
    drivers++; decaps++;
  }

  // Dead-man and header go in before the registers: the registers can move
  // anywhere near their quads, the service strip cannot.
  const dmT = [-(half - 9), -(half - 3)], hdT = [0, -(half - 3)];
  const dmP = placeWorld(SERVICE_FPS.deadman, dmT, stator.coils, obsB, placed, CLR, cellHalf * 2, 0.25, [0]);
  const dmAt = dmP.fits ? dmP.at : dmT;
  placed.push(...partRects(SERVICE_FPS.deadman, dmAt[0], dmAt[1], 0));
  emitDeadman(L, cx0 + dmAt[0], cy0 - dmAt[1], f, 'F', spine);
  const hdP = placeWorld(SERVICE_FPS.header, hdT, stator.coils, obsB, placed, CLR, cellHalf * 2, 0.25, [0]);
  const hdAt = hdP.fits ? hdP.at : hdT;
  placed.push(...partRects(SERVICE_FPS.header, hdAt[0], hdAt[1], 0));
  emitHeader(L, cx0 + hdAt[0], cy0 - hdAt[1], f, 'F', [
    { num: netVBUS, name: 'VBUS' }, { num: netGND, name: 'GND' }, spine.vcc,
    dataNet(0), dataNet(M), spine.sclk, spine.rclk, spine.sync, spine.sda, spine.scl,
  ]);

  // The shift chain that makes the PWM nets real: one 595 per serpentine
  // quad, searched clear of the bridges, caps, stubs and service parts. Same
  // package escalation as the single-board plan: TSSOP-16 if it fits (it is
  // marginal between hex bridges once the stubs are honest obstacles), else
  // the DHVQFN-16.
  let regPkg = 'qfn16', regPlan = null, regBest = null;
  for (const pkg of ['tssop16', 'qfn16']) {
    const mark = placed.length;
    const out = [];
    let fails = 0;
    for (const reg of chain.registers) {
      const p = placeWorld(FOOTPRINTS[pkg], [reg.x, reg.y], stator.coils, obsB, placed, CLR, cellHalf * 2, 0.5);
      if (!p.fits && ++fails >= 3 && pkg !== 'qfn16') break;
      const at = p.fits ? p.at : [reg.x, reg.y];
      placed.push(...partRects(FOOTPRINTS[pkg], at[0], at[1], p.fits ? (p.rotDeg * Math.PI) / 180 : 0));
      out.push({ reg, at, rotDeg: p.fits ? p.rotDeg : 0, fits: p.fits });
    }
    // Any fallback keeps escalating: seat every register or try smaller.
    if (out.length === chain.registers.length && (!regBest || fails < regBest.fails)) {
      regBest = { out, pkg, fails, rects: placed.slice(mark) };
    }
    placed.length = mark;
    if (regBest && regBest.fails === 0) break;
  }
  placed.push(...regBest.rects);
  regPlan = regBest.out;
  regPkg = regBest.pkg;
  regPlan.forEach(({ reg, at, rotDeg, fits }, r) => {
    if (!fits) regsFallback++;
    const q = Array.from({ length: 8 }, (_, k) => {
      const coil = reg.coils[k >> 1];
      if (coil == null) return { num: 0, name: '' };
      return k % 2 === 0
        ? { num: pA(coil), name: `PWMA_${coil}` }
        : { num: pB(coil), name: `PWMB_${coil}` };
    });
    emitShift595(L, reg.ref, cx0 + at[0], cy0 - at[1], rotDeg, f, 'F', {
      vcc: spine.vcc, gnd: spine.gnd, sclk: spine.sclk, rclk: spine.rclk,
      oen: spine.oen, ds: dataNet(r), q7s: dataNet(r + 1), q,
    }, regPkg);
  });

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      drivers, decaps, mating, layers: 2, coils: C, boardMm: 2 * half,
      driverTopology: 'H-bridge per coil (independent)',
      registers: M, chainBits: chain.bits, registersUnplaced: regsFallback,
      registerPackage: regPkg, decapsMoved, outSwapped,
      nets: 2 + 4 * C + 8 + (M + 1),
    },
    // Firmware's contract with the copper: which frame bit reaches which coil
    // pin. Generated beside the placement so it cannot go stale independently.
    contract: { chainBits: chain.bits, shiftOrder: 'bit 0 is clocked out first', bitMap: chain.bitMap },
  };
}

/** Build a complete .kicad_pcb for the PCB stator. Returns { text, stats } or
 *  null when the coil type is not a PCB (nothing to fabricate as copper). */
export function buildKiCad(stator, cfg, opts = {}) {
  if (!isPcbCoil(cfg.stator.coilType)) return null;

  const N = cfg.stator.pcbLayers;                     // physical stackup (fab presses this)
  const g = pcbCoilGeometry(cfg);
  const NC = g.layers;                                // winding layers (= N minus electronics layers)
  // Single-board build: with spare layer(s), the electronics land on B.Cu at
  // the fit-verified positions. opts.sensorSpacing (m) additionally places the
  // TMAG grid; without it the sensors are simply omitted from this export.
  const elec = cfg.stator.pcbSpareLayers > 0
    ? backsideFit(cfg, { stator, sensorSpacing: opts.sensorSpacing ?? null })
    : null;
  const chain = elec?.available ? elec.chain : null;
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  // Self-tileable outline: the union boundary of the coil cells. Everything
  // conductive lives inside its own cell (validatePcb), so cutting along cell
  // boundaries loses nothing -- and abutted copies of the board continue the
  // lattice seamlessly (see tileability() for the hex row-parity caveat).
  const outline = cellOutline(stator, cfg);
  const half = outline.reduce((a, p) => Math.max(a, Math.abs(p[0]), Math.abs(p[1])), 0);
  const cx0 = half + 10, cy0 = half + 10;             // keep all coords positive
  const plan = viaPlan(g, NC, cellHalf, via);
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
  // Single-board electronics nets: per-coil PWM pairs, the command spine, the
  // chain links, and per-bus I2C for the sensor grid.
  const pwmA = (i) => ({ num: C + 1 + 2 * i, name: `PWMA_${i}` });
  const pwmB = (i) => ({ num: C + 2 + 2 * i, name: `PWMB_${i}` });
  let spine = null, dataNet = null, sdaNet = null, nSensBus = 0;
  if (elec?.available) {
    const sb = 3 * C + 1;
    spine = {
      vbus: { num: sb, name: 'VBUS' }, gnd: { num: sb + 1, name: 'GND' },
      vcc: { num: sb + 2, name: 'VLOGIC' }, sclk: { num: sb + 3, name: 'SCLK' },
      rclk: { num: sb + 4, name: 'RCLK' }, oen: { num: sb + 5, name: 'OE_N' },
      sync: { num: sb + 6, name: 'SYNC' }, ng: { num: sb + 7, name: 'DEADMAN_G' },
      scl: { num: sb + 8, name: 'SCL' },
    };
    const M = chain.registers.length;
    dataNet = (r) => ({ num: sb + 9 + r, name: `DATA_${r}` });
    nSensBus = elec.sensors ? Math.ceil(elec.sensors.placed / 4) : 0;
    sdaNet = (b) => ({ num: sb + 9 + (M + 1) + b, name: `SDA_${b}` });
    for (let i = 0; i < C; i++) {
      L.push(`  (net ${pwmA(i).num} "${pwmA(i).name}")`);
      L.push(`  (net ${pwmB(i).num} "${pwmB(i).name}")`);
    }
    for (const k of ['vbus', 'gnd', 'vcc', 'sclk', 'rclk', 'oen', 'sync', 'ng', 'scl']) {
      L.push(`  (net ${spine[k].num} "${spine[k].name}")`);
    }
    for (let r = 0; r <= M; r++) L.push(`  (net ${dataNet(r).num} "${dataNet(r).name}")`);
    for (let b = 0; b < nSensBus; b++) L.push(`  (net ${sdaNet(b).num} "${sdaNet(b).name}")`);
  }

  // --- board outline: the cell-union boundary (self-tileable) ---
  for (let e = 0; e < outline.length; e++) {
    const a = outline[e], b = outline[(e + 1) % outline.length];
    L.push(`  (gr_line (start ${f(cx0 + a[0])} ${f(cy0 - a[1])}) (end ${f(cx0 + b[0])} ${f(cy0 - b[1])}) (layer "Edge.Cuts") (width 0.1))`);
  }

  // --- coils ---
  let segments = 0, vias = 0, termPads = 0;
  const layerPath = Array.from({ length: NC }, (_, j) => spiralPath(g, j));
  for (let ci = 0; ci < stator.coils.length; ci++) {
    const c = stator.coils[ci];
    const net = ci + 1;
    // Sim centres are metres, board centred on origin; flip y for KiCad's
    // y-down page so the exported array reads the same way up as the render.
    const ox = cx0 + c.x * 1000, oy = cy0 - c.y * 1000;
    const tx = (p0) => f(ox + p0);
    const ty = (p1) => f(oy + p1);

    // The spiral tracks, layer by layer: straight edges and arc corners. Only
    // the winding layers carry spirals -- a spare (electronics) bottom layer
    // gets via annulars and I/O pads, never turns.
    for (let j = 0; j < NC; j++) {
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
    // The coil's input/output SMT pads on the back, at the terminal vias.
    // The footprint is emitted UNROTATED with the angle on the pad itself:
    // KiCad takes a pad's angle literally (it is not composed with the
    // footprint's), so a rotated footprint around an angle-0 pad draws an
    // axis-aligned pad -- copper validatePcb never approved. Proven against
    // kicad-cli renders before this was changed.
    (plan.termPads || []).forEach((pad, k) => {
      // Plan angles live in the board's y-down frame, so the world angle is
      // -p.a -- and KiCad pad angles are CCW in the y-up sense (measured off
      // kicad-cli renders), so the world angle is what gets written.
      const deg = (-(pad.a || 0) * 180) / Math.PI;
      L.push(`  (footprint "maglev:Term" (layer "B.Cu") (at ${tx(pad.p[0])} ${ty(pad.p[1])})`);
      L.push('    (attr smd)');
      L.push(`    (fp_text reference "J${ci}.${k === 0 ? 'IN' : 'OUT'}" (at 0 -${f(pad.h / 2 + 0.3)}) (layer "B.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05)) (justify mirror)))`);
      L.push(`    (fp_text value "term" (at 0 0) (layer "B.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05)) (justify mirror)))`);
      L.push(`    (pad "1" smd rect (at 0 0 ${f(deg)}) (size ${f(pad.w)} ${f(pad.h)}) (layers "B.Cu" "B.Paste" "B.Mask") (net ${net} "coil_${ci}"))`);
      L.push('  )');
      termPads++;
    });
  }

  // --- single-board electronics on the spare bottom layer ---
  // Everything lands at fit-verified positions: bridges at the one per-cell
  // placement that provably tiles, registers searched clear near their quad
  // centroids, sensors at the nudged grid spots. World-anchored parts are
  // emitted as (coil centre) + (local offset) in the SAME local frame the fit
  // search cleared, so the pads sit exactly where the proof looked.
  let bridges = 0, sensorCount = 0, regsFallback = 0;
  let contract = null;
  if (elec?.available) {
    // World mm (y-up) -> board file mm. Every planned position goes through
    // this one mapping, so the copper lands exactly where the plan cleared it.
    const wx = (x) => cx0 + x, wy = (y) => cy0 - y;
    const bridgePkg = elec.planStats?.bridgePackage ?? 'sop8';
    for (const b of elec.bridges ?? []) {
      emitBridge8(L, `U${b.coil}`, wx(b.at[0]), wy(b.at[1]), b.rotDeg, f, 'B', {
        in1: pwmA(b.coil), in2: pwmB(b.coil), vbus: spine.vbus, gnd: spine.gnd,
        outa: { num: b.coil + 1, name: `coil_${b.coil}` }, outb: { num: b.coil + 1, name: `coil_${b.coil}` },
      }, bridgePkg);
      if (b.cap) {
        emitPart(L, {
          lib: 'C0402', value: '100n', ref: `C${b.coil}`, S: 'B',
          at: [wx(b.cap.at[0]), wy(b.cap.at[1])], rotDeg: b.cap.rotDeg,
          fp: BACKPLANE_FPS.c0402, nets: [spine.vbus, spine.gnd], f,
        });
      }
      bridges++;
    }
    const M = chain.registers.length;
    (elec.registers ?? []).forEach((reg, r) => {
      if (!reg.fits) regsFallback++;
      const q = Array.from({ length: 8 }, (_, k) => {
        const coil = reg.coils[k >> 1];
        if (coil == null) return { num: 0, name: '' };
        return k % 2 === 0 ? pwmA(coil) : pwmB(coil);
      });
      emitShift595(L, reg.ref, wx(reg.at[0]), wy(reg.at[1]), reg.rotDeg, f, 'B', {
        vcc: spine.vcc, gnd: spine.gnd, sclk: spine.sclk, rclk: spine.rclk,
        oen: spine.oen, ds: dataNet(r), q7s: dataNet(r + 1), q,
      }, elec.planStats?.regPackage ?? 'tssop16');
    });
    const sensorContract = [];
    if (elec.sensors) {
      elec.sensors.list.forEach((s, k) => {
        const bus = k >> 2;
        emitSensor(L, `MS${k}`, wx(s.atMm[0]), wy(s.atMm[1]), s.rotDeg, f, 'B', {
          scl: spine.scl, gnd: spine.gnd, sda: sdaNet(bus),
          int: spine.sync, vcc: spine.vcc,
        });
        sensorContract.push({ ref: `MS${k}`, bus, addrVariant: k % 4, atMm: s.atMm, nudgeMm: s.nudgeMm, rotDeg: s.rotDeg });
        sensorCount++;
      });
    }
    emitDeadman(L, wx(elec.service.deadman.at[0]), wy(elec.service.deadman.at[1]), f, 'B', spine);
    emitHeader(L, wx(elec.service.header.at[0]), wy(elec.service.header.at[1]), f, 'B', [
      spine.vbus, spine.gnd, spine.vcc, dataNet(0), dataNet(M),
      spine.sclk, spine.rclk, spine.sync, nSensBus > 0 ? sdaNet(0) : spine.scl, spine.scl,
    ]);
    contract = {
      chainBits: chain.bits, shiftOrder: 'bit 0 is clocked out first',
      bitMap: chain.bitMap, sensors: sensorContract,
      note: nSensBus > 1 ? `SDA_1..SDA_${nSensBus - 1} route to the master section; the tile header carries SDA_0 only.` : undefined,
    };
  }

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      coils: stator.coils.length, layers: N, coilLayers: NC, turnsPerLayer: g.turns,
      segments, vias, viasPerCoil: plan.counts.perCoil,
      innerVias: plan.counts.inner, outerVias: plan.counts.outer,
      viaTech: 'through-hole (plated)', cornerVias: true,
      termPads, termPadsPerCoil: (plan.termPads || []).length,
      nets: stator.coils.length, boardMm: 2 * half, traceMm: g.trace,
      drivers: bridges,
      driverTopology: elec?.available
        ? (bridges ? 'single-board: bridge per coil on B.Cu' : 'single-board: no bridge package fits')
        : 'backplane (separate board)',
      registers: elec?.available ? chain.registers.length : 0,
      registersUnplaced: regsFallback,
      registerPackage: elec?.planStats?.regPackage ?? null,
      bridgePackage: elec?.planStats?.bridgePackage ?? null,
      sensors: sensorCount,
      bridgesMoved: elec?.planStats?.bridgesMoved ?? 0,
      bridgesColliding: elec?.planStats?.bridgeFallback ?? 0,
      serviceFallback: elec?.planStats?.serviceFallback ?? 0,
      tile: tileability(stator, cfg),
    },
    contract,
    // The placement plan the board was emitted from -- sensors with their
    // as-placed positions, the plan stats, the fit card. Plain data, so a
    // worker can post it back to the UI thread without re-running the plan.
    elec,
  };
}

// --- back-side component fit ------------------------------------------------
//
// The single-board driver-per-coil build surrenders the bottom copper to parts
// (pcbSpareLayers), but "a layer with no winding" is not "a layer with room":
// every crossover and terminal via is a plated through-hole whose land arrives
// on B.Cu whether the winding does or not, plus the two I/O pads per coil. A
// component's SOLDER PADS must clear all of that copper; its body may span
// tented vias. Whether a given package class fits is therefore a geometry
// question the model can answer, and it decides the build: per-cell bridges on
// the coil board, or the separate backplane.
//
// The lattice is periodic, so one cell is solved and the answer stamps to all
// of them: obstacles are this cell's plan plus its neighbours' translated
// copies, and the part's extent must also clear its OWN copies one lattice
// step away (identical placement per cell tiles iff the extent fits a period).

/** Representative land patterns, millimetres, centred, pads before rotation.
 *  These are placement-envelope models (body + pad rectangles), not fab-ready
 *  footprints -- close enough to answer "does this package class fit". */
/** The parts behind the envelopes: real, orderable, verified in stock at LCSC
 *  (fetched 2026-07-27, stock quoted as seen). The footprints above stay
 *  function-named envelopes; this is what you put in the cart. One deliberate
 *  asymmetry: the flux sensor of record is the TMAG5273 (four I2C address
 *  variants, so four sensors share a bus -- the firmware contract's
 *  addrVariant field assumes it), but LCSC does not stock it; the LCSC-native
 *  alternative is the TLV493D, which has TWO addresses, so plan twice the
 *  buses if you build from this list alone. */
export const BOM = [
  { role: 'bridge (dense cells)', part: 'DRV8837DSGR', mfr: 'TI', pkg: 'WSON-8-EP 2x2',
    lcsc: 'C39159', stock: 31550, unit: 0.173, at: 500,
    note: '11 V max, 1.8 A -- 9 V bus with margin; exposed pad to GND' },
  { role: 'bridge (roomy cells)', part: 'TC118S', mfr: 'Fuman', pkg: 'SOP-8',
    lcsc: 'C88308', stock: 115970, unit: 0.033, at: 500,
    note: '2-9 V rating: ZERO margin at a 9 V bus -- run 8 V, or pay for the DRV8837' },
  { role: 'shift register (dense)', part: '74HC595BQ,115', mfr: 'Nexperia', pkg: 'DHVQFN-16 2.5x3.5',
    lcsc: 'C730243', stock: 162365, unit: 0.111, at: 500 },
  { role: 'shift register (roomy)', part: '74HC595PW,118', mfr: 'Nexperia', pkg: 'TSSOP-16',
    lcsc: 'C5948', stock: 100000, unit: 0.086, at: 500 },
  { role: 'flux sensor (LCSC alt)', part: 'TLV493DA1B6HTSA2', mfr: 'Infineon', pkg: 'SOT-23-6',
    lcsc: 'C126688', stock: 1, unit: 0.45, at: 100,
    note: '3-axis I2C, +/-130 mT; TWO I2C addresses (TMAG5273 has four) -- double the sensor buses. TMAG5273 itself: DigiKey, not LCSC' },
  { role: 'dead-man FET', part: '2N7002,215', mfr: 'Nexperia', pkg: 'SOT-23',
    lcsc: 'C65189', stock: 567750, unit: 0.008, at: 500,
    note: 'the classic C8545 was OUT of stock when checked -- part numbers rot, verify yours' },
  { role: 'decap', part: 'CL05B104KO5NNNC', mfr: 'Samsung', pkg: '0402 100n 16V X7R',
    lcsc: 'C1525', stock: 1627700, unit: 0.005, at: 100 },
];

export const FOOTPRINTS = {
  sop8: {
    // Includes the bundled 100n decap's two pads beside the chip, so the fit
    // verdict covers exactly what emitBridge8 places -- chip AND cap.
    label: 'SOP-8 bridge + 100n (TC118S-class)', body: [4.9, 3.9],
    pads: [-1.905, -0.635, 0.635, 1.905].flatMap((y) =>
      [[-2.7, y, 1.5, 0.6], [2.7, y, 1.5, 0.6]])
      .concat([[-0.5, 2.6, 0.4, 0.5], [0.5, 2.6, 0.4, 0.5]]),
  },
  dfn8: {
    // WSON-8-EP: the exposed die pad is SOLDERED copper, so unlike the body
    // it must clear the via field -- which is exactly the constraint that
    // decides whether this package can sit over a cell's centre crossovers.
    label: '2x2 DFN bridge (DRV8837, WSON-8-EP)', body: [2.2, 2.2],
    pads: [-0.75, -0.25, 0.25, 0.75].flatMap((y) =>
      [[-0.85, y, 0.6, 0.3, 0.09], [0.85, y, 0.6, 0.3, 0.09]])
      .concat([[0, 0, 0.9, 1.6, 0.09]]),
  },
  sot23_6: {
    label: 'SOT-23-6 sensor (TMAG5273)', body: [2.9, 1.6],
    pads: [-0.95, 0, 0.95].flatMap((y) =>
      [[-1.1, y, 0.9, 0.6], [1.1, y, 0.9, 0.6]]),
  },
  tssop16: {
    // One per FOUR coils, so it need not tile every cell: `sparse` skips the
    // periodic-copy check (copies sit >= 2 lattice steps apart) while the
    // via/pad obstacles -- which repeat in EVERY cell -- are still enforced.
    label: 'TSSOP-16 shift register (74HC595)', body: [5.0, 4.4], sparse: true,
    pads: Array.from({ length: 8 }, (_, k) => -2.275 + k * 0.65).flatMap((y) =>
      [[-2.9, y, 1.2, 0.4], [2.9, y, 1.2, 0.4]]),
  },
  qfn16: {
    // The same 74HC595 in DHVQFN-16 (2.5 x 3.5 mm): the register the DENSE
    // build reaches for. A honeycomb cell that already carries the bridge has
    // no 7 x 5 mm hole left for a TSSOP -- that is a fact about the cell, not
    // the search -- but a 3.6 x 3.9 mm envelope drops into the gutter regions.
    // Same die, same pin functions, an LCSC catalogue part (74HC595BQ-class).
    label: 'DHVQFN-16 shift register (74HC595BQ)', body: [2.5, 3.5], sparse: true,
    pads: Array.from({ length: 8 }, (_, k) => -1.75 + k * 0.5).flatMap((y) =>
      [[-1.4, y, 0.8, 0.3], [1.4, y, 0.8, 0.3]]),
  },
};

// Oriented rectangle {cx, cy, w, h, ang} helpers.
function rectCorners(r) {
  const c = Math.cos(r.ang), s = Math.sin(r.ang), hw = r.w / 2, hh = r.h / 2;
  return [[hw, hh], [hw, -hh], [-hw, -hh], [-hw, hh]]
    .map(([x, y]) => [r.cx + x * c - y * s, r.cy + x * s + y * c]);
}
function rectsOverlap(a, b) {
  // Separating-axis test on both rectangles' edge normals.
  for (const r of [a, b]) {
    for (const [ux, uy] of [[Math.cos(r.ang), Math.sin(r.ang)], [-Math.sin(r.ang), Math.cos(r.ang)]]) {
      const pa = rectCorners(a).map(([x, y]) => x * ux + y * uy);
      const pb = rectCorners(b).map(([x, y]) => x * ux + y * uy);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}
function rectHitsCircle(r, cx, cy, rad) {
  // Closest point on the rectangle to the circle centre, in the rect's frame.
  const c = Math.cos(r.ang), s = Math.sin(r.ang), dx = cx - r.cx, dy = cy - r.cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.max(Math.abs(lx) - r.w / 2, 0), qy = Math.max(Math.abs(ly) - r.h / 2, 0);
  return qx * qx + qy * qy <= rad * rad;
}

/** Everything already occupying the electronics face of ONE coil cell, in
 *  coil-local millimetres: crossover + terminal via lands (discs) and the two
 *  I/O pads (rects). Shares viaPlan with the export, so the keepouts are the
 *  copper actually emitted, not a redescription of it. */
export function backsideObstacles(cfg) {
  const g = pcbCoilGeometry(cfg);
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const plan = viaPlan(g, g.layers, cellHalf, via);
  // The via plan's frame is the BOARD's: emission writes plan y straight into
  // file y (down-screen). Part placement runs in the world frame (y up), so
  // the obstacles flip here, once -- y negates and so do angles. Skipping this
  // flip made every part clear the MIRROR of the cell's copper, which is how
  // sensors kept landing on real vias their placement proof had dodged.
  const discs = [...plan.vias, ...plan.termVias].map((v) => ({ x: v.p[0], y: -v.p[1], r: via / 2 }));
  const rects = (plan.termPads || []).map((p) => ({ cx: p.p[0], cy: -p.p[1], w: p.w, h: p.h, ang: -p.a }));
  const hex = (g.sides ?? 4) === 6;
  const p = cfg.stator.coilPitch * 1000;
  // Nearest-neighbour lattice offsets (mm): 6 for the triangular lattice, 8 for
  // the square grid (diagonals included -- a big part can reach them).
  const dv = p * Math.sqrt(3) / 2;
  const offsets = hex
    ? [[p, 0], [-p, 0], [p / 2, dv], [p / 2, -dv], [-p / 2, dv], [-p / 2, -dv]]
    : [[p, 0], [-p, 0], [0, p], [0, -p], [p, p], [p, -p], [-p, p], [-p, -p]];
  return { discs, rects, offsets, cellHalf, via, hex, pitchMm: p, g };
}

function padClear(pad, obs, clearance) {
  for (const [ox, oy] of [[0, 0], ...obs.offsets]) {
    for (const d of obs.discs) {
      if (rectHitsCircle(pad, d.x + ox, d.y + oy, d.r + clearance)) return false;
    }
    for (const r of obs.rects) {
      if (rectsOverlap(pad, { ...r, cx: r.cx + ox, cy: r.cy + oy, w: r.w + 2 * clearance, h: r.h + 2 * clearance })) return false;
    }
  }
  return true;
}

/** Is the footprint, placed at (cx,cy) rotation ang (coil-local mm), clear of
 *  every obstacle AND of its own periodic copies? Exported so the tests can
 *  re-verify any placement the search returns. */
export function placementClear(fp, cx, cy, ang, obs, clearance) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (const [px, py, w, h] of fp.pads) {
    const pad = { cx: cx + px * c - py * s, cy: cy + px * s + py * c, w, h, ang };
    if (!padClear(pad, obs, clearance)) return false;
  }
  // Periodic-copy check on the part's full extent (body + pads): identical
  // per-cell placement tiles iff the extent clears its own lattice translates.
  const ex = Math.max(fp.body[0] / 2, ...fp.pads.map(([px, , w]) => Math.abs(px) + w / 2));
  const ey = Math.max(fp.body[1] / 2, ...fp.pads.map(([, py, , h]) => Math.abs(py) + h / 2));
  // The copies must clear each other by the same margin the pads keep from
  // everything else -- touching extents pass an overlap test but fail DRC.
  const extent = { cx, cy, w: 2 * ex + clearance, h: 2 * ey + clearance, ang };
  if (!fp.sparse) {
    for (const [ox, oy] of obs.offsets) {
      if (rectsOverlap(extent, { ...extent, cx: cx + ox, cy: cy + oy })) return false;
    }
  }
  return true;
}

const ROTS = [0, Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3, 3 * Math.PI / 4, 5 * Math.PI / 6];

/** Every rectangle a footprint puts down at (cx, cy, ang): its pads plus its
 *  body, in the frame (cx, cy) is given in. This is the shape that placement
 *  must clear and that later placements must avoid -- pads because copper
 *  shorts, body because two packages cannot occupy the same air. */
function partRects(fp, cx, cy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const out = fp.pads.map(([px, py, w, h]) =>
    ({ cx: cx + px * c - py * s, cy: cy + px * s + py * c, w, h, ang }));
  const [bx, by] = fp.bodyOff ?? [0, 0];
  // The body rect is flagged: it collides with other PARTS (two packages
  // cannot share air) but not with vias or pads -- a body may span tented
  // vias, which is the whole reason the dense cells are populatable at all.
  out.push({ cx: cx + bx * c - by * s, cy: cy + bx * s + by * c, w: fp.body[0], h: fp.body[1], ang, body: true });
  return out;
}

const coilsNear = (coils, x, y, radius) =>
  coils.filter((c) => Math.abs(c.x * 1000 - x) <= radius && Math.abs(c.y * 1000 - y) <= radius);

/** Do these world-frame rects clear every via land and terminal pad (tested in
 *  the local frame of each nearby coil -- exact, not lattice-approximate) AND
 *  every previously placed part? `placed` is the accumulating world-frame
 *  obstacle list that makes later placements respect earlier ones -- the check
 *  whose absence let shift registers land on top of bridges. */
function worldClear(rects, near, obs, placed, clearance) {
  for (const r of rects) {
    const cull = Math.hypot(r.w, r.h) / 2 + clearance;
    // Cell copper (via lands, terminal pads) blocks PADS only; a part's body
    // may span tented vias (placeInCell has always ruled this way).
    if (!r.body) {
      for (const c of near) {
        const lr = { ...r, cx: r.cx - c.x * 1000, cy: r.cy - c.y * 1000 };
        if (Math.abs(lr.cx) > obs.cellHalf * 1.3 + cull || Math.abs(lr.cy) > obs.cellHalf * 1.3 + cull) continue;
        for (const d of obs.discs) if (rectHitsCircle(lr, d.x, d.y, d.r + clearance)) return false;
        for (const o of obs.rects) if (rectsOverlap(lr, { ...o, w: o.w + 2 * clearance, h: o.h + 2 * clearance })) return false;
      }
    }
    // Other parts block EVERYTHING -- pads and body alike.
    for (const o of placed) {
      if (Math.abs(o.cx - r.cx) > 14 || Math.abs(o.cy - r.cy) > 14) continue;
      if (rectsOverlap(r, { ...o, w: o.w + 2 * clearance, h: o.h + 2 * clearance })) return false;
    }
  }
  return true;
}

/** Search around `target` (world mm) for a clear placement. Same spiral-out
 *  candidate order as placeInCell, but in the world frame against the full
 *  obstacle picture: per-cell vias/pads of every nearby coil plus everything
 *  already placed. */
function placeWorld(fp, target, coils, obs, placed, clearance, searchHalf, step = 0.25, rots = ROTS) {
  const diag = Math.max(...fp.pads.map(([px, py, w, h]) => Math.hypot(px, py) + Math.hypot(w, h) / 2), Math.hypot(...fp.body) / 2);
  const near = coilsNear(coils, target[0], target[1], searchHalf + diag + obs.cellHalf * 1.5);
  const cand = [];
  for (let x = -searchHalf; x <= searchHalf + 1e-9; x += step) {
    for (let y = -searchHalf; y <= searchHalf + 1e-9; y += step) {
      // Radius, not box: `searchHalf` is a promise about the worst offset
      // (a sensor's nudge budget), and a box corner breaks it by sqrt(2).
      if (Math.hypot(x, y) <= searchHalf + 1e-9) cand.push([target[0] + x, target[1] + y]);
    }
  }
  cand.sort((a, b) => Math.hypot(a[0] - target[0], a[1] - target[1]) - Math.hypot(b[0] - target[0], b[1] - target[1]));
  for (const [cx, cy] of cand) {
    for (const ang of rots) {
      if (worldClear(partRects(fp, cx, cy, ang), near, obs, placed, clearance)) {
        return { fits: true, at: [cx, cy], rotDeg: (ang * 180) / Math.PI, offMm: Math.hypot(cx - target[0], cy - target[1]) };
      }
    }
  }
  return { fits: false };
}

/** The fixed service parts as placeable envelopes, pads relative to the same
 *  anchor their emitters use. The header stays horizontal (it is the spine
 *  along the south edge), so its search is position-only. */
/** The backplane's own two per-cell parts as placeable envelopes, matching
 *  what emitPowerStage / emitDecap put down (both are y-symmetric, so the
 *  world and file frames agree). */
const BACKPLANE_FPS = {
  hb6: {
    label: 'HB6 power stage', body: [2.0, 2.0],
    pads: [-0.65, 0, 0.65].flatMap((y) => [[-0.9, y, 0.5, 0.3], [0.9, y, 0.5, 0.3]]),
  },
  c0402: { label: '100n 0402', body: [1.1, 0.7], pads: [[-0.5, 0, 0.4, 0.5], [0.5, 0, 0.4, 0.5]] },
};

const SERVICE_FPS = {
  deadman: {
    label: 'dead-man (R,C,R + SOT-23)', body: [10.2, 2.6], bodyOff: [3.6, 0],
    pads: [0, 2.2, 4.4].flatMap((x) => [[x - 0.5, 0, 0.4, 0.5], [x + 0.5, 0, 0.4, 0.5]])
      .concat([[6.8 - 0.95, 1.0, 0.6, 0.7], [6.8 + 0.95, 1.0, 0.6, 0.7], [6.8, -1.0, 0.6, 0.7]]),
  },
  header: {
    label: 'spine header', body: [19.6, 2.0],
    pads: Array.from({ length: 10 }, (_, k) => [(k - 4.5) * 2, 0, 1.2, 1.8]),
  },
};

/** Search one cell for a clear placement of `fp`. Candidates spiral outward
 *  from the cell centre so the first hit is also the most central. */
function placeInCell(fp, obs, clearance, searchHalf = null, centre = [0, 0], step = 0.25) {
  const half = searchHalf ?? obs.cellHalf;
  const cand = [];
  for (let x = -half; x <= half + 1e-9; x += step) {
    for (let y = -half; y <= half + 1e-9; y += step) cand.push([centre[0] + x, centre[1] + y]);
  }
  cand.sort((a, b) => Math.hypot(a[0] - centre[0], a[1] - centre[1]) - Math.hypot(b[0] - centre[0], b[1] - centre[1]));
  for (const [cx, cy] of cand) {
    for (const ang of ROTS) {
      if (placementClear(fp, cx, cy, ang, obs, clearance)) {
        return { fits: true, at: [cx, cy], rotDeg: (ang * 180) / Math.PI, offMm: Math.hypot(cx - centre[0], cy - centre[1]) };
      }
    }
  }
  return { fits: false };
}

/** Can the electronics layer actually HOST the electronics? Per package class:
 *  a per-cell placement that clears every via land and I/O pad (own cell and
 *  neighbours) and tiles the lattice. Optionally, with `stator` and
 *  `sensorSpacing`: place a SOT-23-6 at each recommended sensor-grid point,
 *  nudging within `nudgeMax` mm, and report the worst nudge -- feed the nudged
 *  positions back through poseObservability before trusting them. */
export function backsideFit(cfg, {
  stator = null, sensorSpacing = null, clearance = 0.2, nudgeMax = 2.5, footprints = FOOTPRINTS,
  // The per-package card is milliseconds; the full collision-checked plan is
  // tens of seconds on a 168-cell board. `plan: false` returns just the card,
  // so a UI can render instantly and run the plan in a worker.
  plan = true,
} = {}) {
  if (!isPcbCoil(cfg.stator.coilType)) return { available: false, reason: 'notpcb' };
  if (!(cfg.stator.pcbSpareLayers > 0)) return { available: false, reason: 'nolayer' };
  const obs = backsideObstacles(cfg);

  // Per-package feasibility card. The two bridge classes see the bare cell;
  // the register and sensor -- which must COEXIST with the chosen bridge --
  // see its pads and body too, so their verdicts stop describing a board where
  // the bridges were never placed.
  const parts = {};
  for (const key of ['sop8', 'dfn8']) {
    if (footprints[key]) parts[key] = { label: footprints[key].label, ...placeInCell(footprints[key], obs, clearance) };
  }
  const std = parts.sop8?.fits ? parts.sop8 : null;
  const obs2 = std
    ? { ...obs, rects: obs.rects.concat(partRects(footprints.sop8, std.at[0], std.at[1], (std.rotDeg * Math.PI) / 180)) }
    : obs;
  for (const key of Object.keys(footprints)) {
    if (!parts[key]) parts[key] = { label: footprints[key].label, ...placeInCell(footprints[key], obs2, clearance) };
  }

  // Full placement plan, in dependency order -- header and dead-man first
  // (they cannot move much), then every cell's bridge, then the registers,
  // then the sensor grid. Each stage accumulates into `placed`, so nothing
  // later can land on anything earlier. This ordering IS the fix for the
  // overlapping driver section: parts used to be placed against the bare
  // cell only, blind to each other.
  //
  // The bridge package escalates like the register's: the SOP-8 bridge plus
  // its cap very nearly FILLS a dense honeycomb cell (measured, not assumed:
  // at 84% fill nothing else places beside it), so if the registers or the
  // sensor grid starve, the whole plan re-runs on the 2 x 2 DFN bridge with a
  // separate 0402 decap -- smaller silicon buys the room the chain needs.
  let service = null, bridges = null, registers = null, sensors = null, chain = null;
  let stats = null;
  if (stator && plan) {
    const coils = stator.coils;
    const outline = cellOutline(stator, cfg);
    const halfB = outline.reduce((a, p) => Math.max(a, Math.abs(p[0]), Math.abs(p[1])), 0);
    chain = chainPlan(stator, cfg);

    const planWith = (bridgeKey) => {
      const st = { bridgesMoved: 0, bridgeFallback: 0, regFallback: 0, serviceFallback: 0, bridgePackage: bridgeKey };
      const placed = [];
      const bfp = footprints[bridgeKey];
      const bStd = parts[bridgeKey]?.fits ? parts[bridgeKey] : null;
      const settle = (fp, p, fallbackAt) => {
        const at = p.fits ? p.at : fallbackAt;
        if (!p.fits) st.serviceFallback++;
        placed.push(...partRects(fp, at[0], at[1], p.fits ? (p.rotDeg * Math.PI) / 180 : 0));
        return { at, rotDeg: p.fits ? p.rotDeg : 0, fits: p.fits };
      };
      const hT = [0, -(halfB - 3)], dT = [-(halfB - 9), -(halfB - 3)];
      const svc = {
        header: settle(SERVICE_FPS.header, placeWorld(SERVICE_FPS.header, hT, coils, obs, placed, clearance, obs.cellHalf, 0.25, [0]), hT),
        deadman: settle(SERVICE_FPS.deadman, placeWorld(SERVICE_FPS.deadman, dT, coils, obs, placed, clearance, obs.cellHalf, 0.25, [0]), dT),
      };

      // Placement runs in order of decreasing rigidity, so the flexible parts
      // yield: the sensors' positions are bought with observability
      // (poseObservability grades every nudge), a bridge works anywhere in
      // its own cell, and a register anywhere near its quad. Cells that lose
      // their standard bridge spot to a sensor simply re-search.
      let sens = null;
      if (sensorSpacing) {
        const gridHalf = cfg.stator.statorSize / 2;
        const n = Math.floor((2 * gridHalf) / sensorSpacing) + 1;
        const list = [];
        let failed = 0, worstNudge = 0;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const swx = (-gridHalf + i * sensorSpacing) * 1000, swy = (-gridHalf + j * sensorSpacing) * 1000;
            const r = placeWorld(footprints.sot23_6, [swx, swy], coils, obs, placed, clearance, nudgeMax);
            if (!r.fits) { failed++; continue; }
            worstNudge = Math.max(worstNudge, r.offMm);
            placed.push(...partRects(footprints.sot23_6, r.at[0], r.at[1], (r.rotDeg * Math.PI) / 180));
            // Anchor by (cell, local offset): the fit is proven relative to
            // the coil lattice; emission re-applies it in the same frame.
            let bi = 0, bd = Infinity;
            for (let k = 0; k < coils.length; k++) {
              const d = Math.hypot(coils[k].x * 1000 - r.at[0], coils[k].y * 1000 - r.at[1]);
              if (d < bd) { bd = d; bi = k; }
            }
            list.push({
              coil: bi, local: [r.at[0] - coils[bi].x * 1000, r.at[1] - coils[bi].y * 1000],
              rotDeg: r.rotDeg,
              atMm: [r.at[0], r.at[1]], nudgeMm: r.offMm,
            });
          }
        }
        sens = { wanted: n * n, placed: list.length, failed, worstNudgeMm: worstNudge, list };
      }
      // Two passes over the bridges, so the service parts cannot start a
      // cascade: every cell whose standard (periodicity-proven) spot is
      // untouched keeps it; only the handful shadowed by the header or
      // dead-man re-search, against a field of already-final neighbours.
      let brs = null;
      if (bStd) {
        const stdRad = (bStd.rotDeg * Math.PI) / 180;
        const needCap = !bfp.pads.some(([, py]) => py > bfp.body[1] / 2 + 0.4); // no bundled decap in the envelope
        const stdOf = (c) => [c.x * 1000 + bStd.at[0], c.y * 1000 + bStd.at[1]];
        const blocked = [];
        brs = coils.map((c, ci) => {
          const at = stdOf(c);
          const rects = partRects(bfp, at[0], at[1], stdRad);
          if (worldClear(rects, [], obs, placed, clearance)) {
            placed.push(...rects);
            return { coil: ci, at, rotDeg: bStd.rotDeg, moved: false };
          }
          blocked.push(ci);
          return null;
        });
        for (const ci of blocked) {
          const c = coils[ci];
          const p = placeWorld(bfp, [c.x * 1000, c.y * 1000], coils, obs, placed, clearance, obs.cellHalf);
          let out;
          if (p.fits) { st.bridgesMoved++; out = { coil: ci, at: p.at, rotDeg: p.rotDeg, moved: true }; }
          else { st.bridgeFallback++; out = { coil: ci, at: stdOf(c), rotDeg: bStd.rotDeg, moved: false, collides: true }; }
          placed.push(...partRects(bfp, out.at[0], out.at[1], (out.rotDeg * Math.PI) / 180));
          brs[ci] = out;
        }
        // A bare-die bridge brings no decap pads of its own: give every cell a
        // 0402 next to its bridge, searched like everything else.
        if (needCap) {
          for (const b of brs) {
            const p = placeWorld(BACKPLANE_FPS.c0402, [b.at[0] + 1.6, b.at[1]], coils, obs, placed, clearance, 2.0, 0.25, [0, Math.PI / 2]);
            if (p.fits) {
              b.cap = { at: p.at, rotDeg: p.rotDeg };
              placed.push(...partRects(BACKPLANE_FPS.c0402, p.at[0], p.at[1], (p.rotDeg * Math.PI) / 180));
            }
          }
        }
      }

      // Register package escalation: TSSOP-16 if the board has room for it,
      // else the same 74HC595 in DHVQFN-16. A pass aborts on its third
      // failure -- a package that cannot serve three quads is the wrong
      // package, and mixing the two on one board would be a silly BOM.
      const regPkgs = ['tssop16', 'qfn16'].filter((k) => footprints[k]);
      let regs = null, best = null;
      for (const pkg of regPkgs) {
        const mark = placed.length;
        const out = [];
        let fails = 0;
        for (const reg of chain.registers) {
          const p = placeWorld(footprints[pkg], [reg.x, reg.y], coils, obs, placed, clearance, obs.cellHalf * 2, 0.5);
          if (!p.fits && ++fails >= 3 && pkg !== regPkgs[regPkgs.length - 1]) break;
          const at = p.fits ? p.at : [reg.x, reg.y];
          placed.push(...partRects(footprints[pkg], at[0], at[1], p.fits ? (p.rotDeg * Math.PI) / 180 : 0));
          out.push({ ...reg, at, rotDeg: p.fits ? p.rotDeg : 0, fits: p.fits });
        }
        // A pass with ANY fallback keeps escalating -- a smaller package that
        // seats every register beats a bigger one that stacks even a single
        // register on other copper.
        if (out.length === chain.registers.length && (!best || fails < best.fails)) {
          best = { out, pkg, fails, rects: placed.slice(mark) };
        }
        placed.length = mark;
        if (best && best.fails === 0) break;
      }
      if (best) {
        placed.push(...best.rects);
        regs = best.out;
        st.regPackage = best.pkg;
        st.regFallback = best.fails;
      }

      const misses = st.regFallback + st.bridgeFallback + (sens ? sens.failed : 0);
      return { svc, brs, regs, sens, st, misses };
    };

    const bridgeKeys = ['sop8', 'dfn8'].filter((k) => footprints[k] && parts[k]?.fits);
    let plan = null;
    for (const bk of bridgeKeys) {
      const p = planWith(bk);
      if (!plan || p.misses < plan.misses) plan = p;
      if (p.misses === 0) break;                  // nothing starves: take it
    }
    if (!plan) plan = planWith(bridgeKeys[0] ?? 'sop8');
    ({ svc: service, brs: bridges, regs: registers, sens: sensors, st: stats } = plan);
  }

  return {
    available: true,
    obstaclesPerCell: obs.discs.length + obs.rects.length,
    gutterMm: obs.pitchMm * (1 - cfg.stator.coilFill),
    holeMm: 2 * obs.g.halfIn,
    clearance, parts, sensors, service, bridges, registers, chain, planStats: stats,
  };
}

// --- shift chain + firmware contract ----------------------------------------
//
// The PWM nets are only real if something drives them. One 74HC595 serves four
// coils (8 outputs = 4 x IN1/IN2), registers daisy-chain DS -> Q7S in the same
// serpentine order the coils are walked, and the whole chain hangs off five
// shared lines (VLOGIC, SCLK, RCLK, /OE, DATA). Which frame bit lands on which
// coil pin is FIRMWARE'S contract with the copper, so it is computed here --
// once, next to the placement -- and returned as data instead of being
// re-derived by hand on the other side of the toolchain.
//
// Shift order: bit 0 is the FIRST bit the MCU clocks out. After 8M clocks it
// has been pushed all the way to the far end of the chain: chip M-1, output
// Q7. So bit b lives at global output g = 8M-1-b, chip floor(g/8), Q(g%8).

/** Group the coils into serpentine quads and plan one register per quad.
 *  Returns { registers: [{ref, x, y (mm), coils}], bits, bitMap } where bitMap
 *  is the frame contract: [{bit, ref, q, coil, input}] (coil = null for the
 *  padding outputs of a short last quad). */
export function chainPlan(stator, cfg) {
  const p = cfg.stator.coilPitch * 1000;
  const hex = cfg.stator.coilType === 'pcbhex';
  const rowH = hex ? p * Math.sqrt(3) / 2 : p;
  // Serpentine: rows bottom-to-top, alternate rows right-to-left, so quad
  // members and consecutive registers are physical neighbours.
  const order = stator.coils
    .map((c, i) => ({ i, x: c.x * 1000, y: c.y * 1000, row: Math.round((c.y * 1000) / rowH) }))
    .sort((a, b) => (a.row - b.row) || ((a.row % 2 === 0 ? 1 : -1) * (a.x - b.x)));
  const registers = [];
  for (let k = 0; k < order.length; k += 4) {
    const quad = order.slice(k, k + 4);
    registers.push({
      ref: `SR${registers.length}`,
      x: quad.reduce((a, c) => a + c.x, 0) / quad.length,
      y: quad.reduce((a, c) => a + c.y, 0) / quad.length,
      coils: quad.map((c) => c.i),
    });
  }
  const M = registers.length;
  const bitMap = [];
  for (let r = 0; r < M; r++) {
    for (let q = 0; q < 8; q++) {
      const coil = registers[r].coils[q >> 1];
      bitMap.push({
        bit: 8 * M - 1 - (8 * r + q),
        ref: registers[r].ref, q: `Q${q}`,
        coil: coil ?? null, input: coil == null ? null : (q % 2 === 0 ? 'IN1' : 'IN2'),
      });
    }
  }
  bitMap.sort((a, b) => a.bit - b.bit);
  return { registers, bits: 8 * M, bitMap };
}

/** A 74HC595 on a TSSOP-16 envelope, REAL pinout, at (ox,oy) rot deg on side S.
 *  `n` maps function -> {num, name} nets: vcc, gnd, sclk, rclk, oen, ds, q7s,
 *  and q[0..7] for the outputs (unused outputs pass net 0 / ""). */
function emitShift595(L, ref, ox, oy, rot, f, S, n, pkg = 'tssop16') {
  // Net order follows the footprint's pad order (rows bottom to top in the
  // world frame, [left, right] per row -- both 595 packages share it): pins
  // 1..8 run DOWN the left side from the world top, 9..16 back UP the right.
  // Pad numbers are sequential in table order, not package pin numbers -- the
  // firmware contract names nets, never pin numbers, so nothing reads them.
  const leftFn = ['gnd', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'];
  const rightFn = ['q7s', 'mr', 'sclk', 'rclk', 'oen', 'ds', 'q0', 'vcc'];
  const netFor = (fn) => {
    if (fn === 'mr') return n.vcc;                       // /MR tied high
    if (fn.startsWith('q') && fn.length <= 2 && fn !== 'q7s') return n.q[+fn.slice(1)] ?? { num: 0, name: '' };
    return n[fn] ?? { num: 0, name: '' };
  };
  const fp = FOOTPRINTS[pkg];
  const nets = fp.pads.map((_, k) => netFor((k % 2 === 0 ? leftFn : rightFn)[k >> 1]));
  emitPart(L, {
    lib: pkg === 'qfn16' ? 'SR595Q' : 'SR595', value: pkg === 'qfn16' ? '74HC595BQ' : '74HC595',
    ref, S, at: [ox, oy], rotDeg: rot, fp, nets, f,
  });
}

/** The /OE dead-man: SYNC strobes keep C1 charged through R1, holding Q1 on and
 *  /OE low (outputs enabled); strobes stop -> C1 decays -> Q1 releases -> R2
 *  pulls /OE high and every 595 tri-states, every bridge input floats to brake.
 *  Envelope parts, function-labelled. */
function emitDeadman(L, ox, oy, f, S, n) {
  const two = (ref, val, x, a, b) => {
    const m = S === 'B' ? ' (justify mirror)' : '';
    L.push(`  (footprint "maglev:R0402" (layer "${S}.Cu") (at ${f(ox + x)} ${f(oy)})`);
    L.push('    (attr smd)');
    L.push(`    (fp_text reference "${ref}" (at 0 -0.6) (layer "${S}.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
    L.push(`    (fp_text value "${val}" (at 0 0.6) (layer "${S}.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
    L.push(fpPad(1, -0.5, 0, 0.4, 0.5, a.num, a.name, S));
    L.push(fpPad(2, 0.5, 0, 0.4, 0.5, b.num, b.name, S));
    L.push('  )');
  };
  two('R1', 'retrigger', 0, n.sync, n.ng);
  two('C1', 'hold', 2.2, n.ng, n.gnd);
  two('R2', 'pull-up', 4.4, n.oen, n.vcc);
  const m = S === 'B' ? ' (justify mirror)' : '';
  L.push(`  (footprint "maglev:SOT23" (layer "${S}.Cu") (at ${f(ox + 6.8)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "Q1" (at 0 -1.6) (layer "${S}.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
  L.push(`    (fp_text value "dead-man" (at 0 1.6) (layer "${S}.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
  // Pads mirror SERVICE_FPS.deadman's world-frame table: world +y is file -y.
  L.push(fpPad(1, -0.95, -1.0, 0.6, 0.7, n.ng.num, n.ng.name, S));  // gate
  L.push(fpPad(2, 0.95, -1.0, 0.6, 0.7, n.gnd.num, n.gnd.name, S)); // source
  L.push(fpPad(3, 0, 1.0, 0.6, 0.7, n.oen.num, n.oen.name, S));     // drain
  L.push('  )');
}

/** The command-spine header: everything a tile (or the full board) needs from
 *  the master, on ten 2 mm pads along the board's south edge. */
function emitHeader(L, ox, oy, f, S, nets) {
  const m = S === 'B' ? ' (justify mirror)' : '';
  L.push(`  (footprint "maglev:HDR10" (layer "${S}.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "J1" (at 0 -1.6) (layer "${S}.SilkS") (effects (font (size 0.4 0.4) (thickness 0.07))${m}))`);
  L.push(`    (fp_text value "spine" (at 0 1.6) (layer "${S}.Fab") hide (effects (font (size 0.4 0.4) (thickness 0.07))${m}))`);
  nets.forEach((net, k) => {
    L.push(fpPad(k + 1, (k - (nets.length - 1) / 2) * 2, 0, 1.2, 1.8, net.num, net.name, S));
  });
  L.push('  )');
}

/** A TMAG5273-class 3-axis sensor on the SOT-23-6 envelope at (ox,oy) rot deg. */
function emitSensor(L, ref, ox, oy, rot, f, S, n) {
  // FOOTPRINTS.sot23_6 pad order: rows bottom to top (world), [left, right].
  // World top-left is SCL, down the left to SDA; NC/VCC/INT down the right.
  const fns = ['sda', 'int', 'gnd', 'vcc', 'scl', 'nc'];
  const nets = fns.map((fn) => n[fn] ?? { num: 0, name: '' });
  emitPart(L, { lib: 'TMAG', value: 'TMAG5273', ref, S, at: [ox, oy], rotDeg: rot, fp: FOOTPRINTS.sot23_6, nets, f });
}

/** An integrated-bridge envelope on the fit-verified SOP-8 land pattern (pads
 *  land on the winding annulus). Function-named pads, not a specific part's
 *  pinout -- MX1508-class per the BOM. Includes the bundled 100n decap's two
 *  pads (last two entries of the sop8 table), so what is emitted is exactly
 *  what backsideFit proved to fit. */
function emitBridge8(L, ref, ox, oy, rot, f, S, n, pkg = 'sop8') {
  // Pad order is rows bottom to top (world), [left, right] -- left column
  // top->bottom is in1,in2,vbus,gnd; right is outa,outb,gnd,vbus. The SOP-8
  // envelope additionally carries its bundled decap pair above the body; the
  // DFN gets a separate 0402 placed by the plan, plus its exposed die pad
  // (GND per the DRV8837 datasheet) as the last table entry.
  const nets = [n.gnd, n.vbus, n.vbus, n.gnd, n.in2, n.outb, n.in1, n.outa]
    .concat(pkg === 'sop8' ? [n.vbus, n.gnd] : [n.gnd]);
  emitPart(L, {
    lib: pkg === 'dfn8' ? 'DFN8HB' : 'SOP8HB', value: pkg === 'dfn8' ? 'DRV8837' : 'TC118S-class',
    ref, S, at: [ox, oy], rotDeg: rot, fp: FOOTPRINTS[pkg], nets, f,
  });
}

// --- self-tileable board outline --------------------------------------------
//
// One board is rarely the whole machine: stroke grows by abutting more stators.
// A straight cut cannot do that for the honeycomb -- at fill 0.84 the hex
// coils' vertices reach 0.49*pitch from their centres while a straight edge
// leaves only 0.43*pitch of row margin, and the +/-pitch/4 row offsets poke
// alternate rows past any vertical line. But the honeycomb CELLS tile the
// plane by definition, and validatePcb already confines every trace, via and
// pad to its coil's own cell. So the board outline that tiles is the union
// boundary of the cells themselves: castellated left/right (following the row
// offsets), zigzag top/bottom (hex edges). Two copies mesh exactly when the
// lattice period continues across the seam -- horizontally always, vertically
// iff the row count is EVEN (the offset alternation must not skip a beat).
// The square grid is the same computation with 4-sided cells, and degenerates
// to the rectangle it always was.

/** The lattice cell polygon around one coil centre (mm, CCW). */
function cellPolygon(cx, cy, cellHalf, sides) {
  const R = cellHalf / Math.cos(Math.PI / sides);
  const phase = sides === 6 ? Math.PI / 6 : -Math.PI / 4;
  return Array.from({ length: sides }, (_, k) => {
    const a = phase + (k * 2 * Math.PI) / sides;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
}

/** Union boundary of every coil's cell, as a closed CCW polygon (mm, board
 *  centre at origin). Shared edges cancel; the survivors chain into the
 *  outline; collinear runs merge (which is what keeps the square grid's
 *  outline the same four lines it always was). */
export function cellOutline(stator, cfg) {
  const sides = cfg.stator.coilType === 'pcbhex' ? 6 : 4;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const edges = new Map();   // "a|b" (canonical) -> {a, b} in walk order
  for (const c of stator.coils) {
    const poly = cellPolygon(c.x * 1000, c.y * 1000, cellHalf, sides);
    for (let k = 0; k < sides; k++) {
      const a = poly[k], b = poly[(k + 1) % sides];
      const ka = key(a), kb = key(b);
      const canon = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (edges.has(canon)) edges.delete(canon);   // interior edge: appears twice
      else edges.set(canon, { a, b, ka, kb });
    }
  }
  // Chain the boundary edges into a loop.
  const byStart = new Map();
  for (const e of edges.values()) byStart.set(e.ka, e);
  const first = edges.values().next().value;
  const loop = [first.a];
  let cur = first;
  for (let guard = 0; guard < edges.size; guard++) {
    const next = byStart.get(cur.kb);
    if (!next || next === first) break;
    loop.push(next.a);
    cur = next;
  }
  loop.push(cur.b);   // close back to the start vertex
  // Merge collinear runs.
  const out = [];
  const n = loop.length - 1;   // last repeats first
  for (let i = 0; i < n; i++) {
    const p = loop[(i - 1 + n) % n], q = loop[i], r = loop[(i + 1) % n];
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    if (Math.abs(cross) > 1e-6) out.push(q);
  }
  return out;
}

/** Can this board extend the stator by abutting copies of itself?
 *  Horizontal tiling holds whenever every row is full (it is, by
 *  construction); vertical tiling additionally needs an even row count so the
 *  hex row-offset alternation continues across the seam. Also reports the
 *  worst copper-to-outline clearance, since the seam puts two boards' rim
 *  copper a fab-clearance apart. */
export function tileability(stator, cfg) {
  if (!isPcbCoil(cfg.stator.coilType)) return { available: false };
  const hex = cfg.stator.coilType === 'pcbhex';
  const p = cfg.stator.coilPitch * 1000;
  const rowH = hex ? p * Math.sqrt(3) / 2 : p;
  // Rows by quantised y; columns = coils per row (the hex row offsets shift x
  // by +/-p/4, so quantising x across ALL rows would double-count columns).
  const rowOf = new Map();
  for (const c of stator.coils) {
    const r = Math.round((c.y * 1000) / rowH);
    rowOf.set(r, (rowOf.get(r) || 0) + 1);
  }
  const nRows = rowOf.size;
  const nCols = Math.max(...rowOf.values());
  const rowsEven = !hex || nRows % 2 === 0;
  // Copper-to-cell-boundary clearance: everything is in-cell (validatePcb), so
  // the binding items are the terminal pads and outer vias nearest a flat.
  // Flat normals: k*60 deg for the pointy-top hex cell, k*90 deg for the square.
  const g = pcbCoilGeometry(cfg);
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const cellHalf = p / 2;
  const plan = viaPlan(g, g.layers, cellHalf, via);
  const sides = hex ? 6 : 4;
  let clear = Infinity;
  const flats = Array.from({ length: sides }, (_, k) => (k * 2 * Math.PI) / sides);
  for (const a of flats) {
    const ux = Math.cos(a), uy = Math.sin(a);
    for (const v of [...plan.vias, ...plan.termVias]) {
      clear = Math.min(clear, cellHalf - (v.p[0] * ux + v.p[1] * uy) - via / 2);
    }
    for (const t of plan.termPads || []) {
      // Oriented half-extent of the pad along this flat normal.
      const ext = (t.w / 2) * Math.abs(Math.cos(t.a - a)) + (t.h / 2) * Math.abs(Math.sin(t.a - a));
      clear = Math.min(clear, cellHalf - (t.p[0] * ux + t.p[1] * uy) - ext);
    }
  }
  // Two abutted boards put rim copper 2*clear apart across the seam. The hex
  // clears it because its pads are confined in-cell (the honeycomb forced
  // that); the square grid's pads deliberately straddle the cell boundary --
  // at high fill the gutter cannot hold them inside -- so square boards do NOT
  // self-tile: abutted copies land pad on pad. The number says which.
  const SEAM_MIN = 0.2;   // mm of copper-to-copper a fab (and sanity) want
  const copperOK = 2 * clear >= SEAM_MIN;
  return {
    available: true,
    latticeX: true, latticeY: rowsEven, copperOK,
    tileable: rowsEven && copperOK,
    nRows, nCols,
    periodXmm: nCols * p, periodYmm: nRows * rowH,
    edgeClearMm: clear, seamGapMm: 2 * clear,
  };
}
