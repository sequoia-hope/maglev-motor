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
// Coordinates are footprint-relative (mm).
function fpPad(n, px, py, w, h, netNum, netName, S = 'F', rot = 0) {
  return `    (pad "${n}" smd rect (at ${px} ${py}${rot ? ` ${rot}` : ''}) (size ${w} ${h}) (layers "${S}.Cu" "${S}.Paste" "${S}.Mask") (net ${netNum} "${netName}"))`;
}

/** Rotate a local pad position by rotDeg with EXACTLY the math placementClear
 *  verified against the keepouts. Rotated parts are emitted as unrotated
 *  footprints with pre-rotated pad positions (plus per-pad angles), so the pads
 *  land at the literal coordinates the fit search cleared -- immune to any
 *  disagreement about KiCad's rotation handedness. */
function rotXY(px, py, rotDeg) {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [px * c - py * s, px * s + py * c];
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

/** Half the square board edge (mm) that contains every coil plus its gutter. For
 *  the square grid this is exactly S/2 (the nominal stator size); the honeycomb
 *  packs coils a little past that nominal edge, so the outline grows to keep all
 *  copper on the board rather than clipping the rim coils. */
function boardHalf(g, stator, S, cellHalf) {
  const sides = g.sides ?? 4, phase = g.phase ?? -Math.PI / 2;
  let ex = 0, ey = 0;
  for (let k = 0; k < sides; k++) {
    const p = polyCorner(k, g.halfOut, sides, phase);
    ex = Math.max(ex, Math.abs(p[0])); ey = Math.max(ey, Math.abs(p[1]));
  }
  const reach = Math.max(cellHalf, ex, ey);   // gutter, or the coil's own axis extent
  let half = S / 2;
  for (const c of stator.coils) {
    half = Math.max(half, Math.abs(c.x * 1000) + reach, Math.abs(c.y * 1000) + reach);
  }
  return half;
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
  const S = cfg.stator.statorSize * 1000;
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const half = boardHalf(g, stator, S, cellHalf);   // matches the coil board's outline
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

  const edge = [[-half, -half], [half, -half], [half, half], [-half, half]];
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

  // The shift chain that makes the PWM nets real: one 595 per serpentine quad
  // at its quad's centroid, DS -> Q7S daisy-chained in the same order.
  for (let r = 0; r < M; r++) {
    const reg = chain.registers[r];
    const q = Array.from({ length: 8 }, (_, k) => {
      const coil = reg.coils[k >> 1];
      if (coil == null) return { num: 0, name: '' };
      return k % 2 === 0
        ? { num: pA(coil), name: `PWMA_${coil}` }
        : { num: pB(coil), name: `PWMB_${coil}` };
    });
    emitShift595(L, reg.ref, cx0 + reg.x, cy0 - reg.y, 0, f, 'F', {
      vcc: spine.vcc, gnd: spine.gnd, sclk: spine.sclk, rclk: spine.rclk,
      oen: spine.oen, ds: dataNet(r), q7s: dataNet(r + 1), q,
    });
  }
  // Dead-man in the south-west margin, header along the south edge.
  emitDeadman(L, cx0 - half + 4, cy0 + half - 3, f, 'F', spine);
  emitHeader(L, cx0, cy0 + half - 3, f, 'F', [
    { num: netVBUS, name: 'VBUS' }, { num: netGND, name: 'GND' }, spine.vcc,
    dataNet(0), dataNet(M), spine.sclk, spine.rclk, spine.sync, spine.sda, spine.scl,
  ]);

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      drivers, decaps, mating, layers: 2, coils: C, boardMm: 2 * half,
      driverTopology: 'H-bridge per coil (independent)',
      registers: M, chainBits: chain.bits,
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
  const bridgeFit = elec?.available && elec.parts.sop8.fits ? elec.parts.sop8 : null;
  const chain = elec?.available ? chainPlan(stator, cfg) : null;
  const S = cfg.stator.statorSize * 1000;             // nominal stator, mm
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const half = boardHalf(g, stator, S, cellHalf);     // grows to contain hex-packed rim coils
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

  // --- board outline ---
  const edge = [[-half, -half], [half, -half], [half, half], [-half, half]];
  for (let e = 0; e < 4; e++) {
    const a = edge[e], b = edge[(e + 1) % 4];
    L.push(`  (gr_line (start ${f(cx0 + a[0])} ${f(cy0 + a[1])}) (end ${f(cx0 + b[0])} ${f(cy0 + b[1])}) (layer "Edge.Cuts") (width 0.1))`);
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
    (plan.termPads || []).forEach((pad, k) => {
      L.push(`  (footprint "maglev:Term" (layer "B.Cu") (at ${tx(pad.p[0])} ${ty(pad.p[1])} ${f((pad.a || 0) * 180 / Math.PI)})`);
      L.push('    (attr smd)');
      L.push(`    (fp_text reference "J${ci}.${k === 0 ? 'IN' : 'OUT'}" (at 0 -${f(pad.h / 2 + 0.3)}) (layer "B.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05)) (justify mirror)))`);
      L.push(`    (fp_text value "term" (at 0 0) (layer "B.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05)) (justify mirror)))`);
      L.push(`    (pad "1" smd rect (at 0 0) (size ${f(pad.w)} ${f(pad.h)}) (layers "B.Cu" "B.Paste" "B.Mask") (net ${net} "coil_${ci}"))`);
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
    const bx = (ci, lx) => cx0 + stator.coils[ci].x * 1000 + lx;
    const by = (ci, ly) => cy0 - stator.coils[ci].y * 1000 + ly;
    if (bridgeFit) {
      for (let ci = 0; ci < C; ci++) {
        emitBridge8(L, `U${ci}`, bx(ci, bridgeFit.at[0]), by(ci, bridgeFit.at[1]), bridgeFit.rotDeg, f, 'B', {
          in1: pwmA(ci), in2: pwmB(ci), vbus: spine.vbus, gnd: spine.gnd,
          outa: { num: ci + 1, name: `coil_${ci}` }, outb: { num: ci + 1, name: `coil_${ci}` },
        });
        bridges++;
      }
    }
    const obsB = backsideObstacles(cfg);
    const M = chain.registers.length;
    for (let r = 0; r < M; r++) {
      const reg = chain.registers[r];
      let bi = 0, bd = Infinity;
      for (let k = 0; k < C; k++) {
        const d = Math.hypot(stator.coils[k].x * 1000 - reg.x, stator.coils[k].y * 1000 - reg.y);
        if (d < bd) { bd = d; bi = k; }
      }
      const p = placeInCell(FOOTPRINTS.tssop16, obsB, elec.clearance, 3.5,
        [reg.x - stator.coils[bi].x * 1000, reg.y - stator.coils[bi].y * 1000], 0.5);
      // No clear spot: emit at the centroid anyway and count it, so the stats
      // say "N registers need manual placement" instead of dropping them.
      const at = p.fits ? p.at : [reg.x - stator.coils[bi].x * 1000, reg.y - stator.coils[bi].y * 1000];
      if (!p.fits) regsFallback++;
      const q = Array.from({ length: 8 }, (_, k) => {
        const coil = reg.coils[k >> 1];
        if (coil == null) return { num: 0, name: '' };
        return k % 2 === 0 ? pwmA(coil) : pwmB(coil);
      });
      emitShift595(L, reg.ref, bx(bi, at[0]), by(bi, at[1]), p.fits ? p.rotDeg : 0, f, 'B', {
        vcc: spine.vcc, gnd: spine.gnd, sclk: spine.sclk, rclk: spine.rclk,
        oen: spine.oen, ds: dataNet(r), q7s: dataNet(r + 1), q,
      });
    }
    const sensorContract = [];
    if (elec.sensors) {
      elec.sensors.list.forEach((s, k) => {
        const bus = k >> 2;
        emitSensor(L, `MS${k}`, bx(s.coil, s.local[0]), by(s.coil, s.local[1]), 0, f, 'B', {
          scl: spine.scl, gnd: spine.gnd, sda: sdaNet(bus),
          int: spine.sync, vcc: spine.vcc,
        });
        sensorContract.push({ ref: `MS${k}`, bus, addrVariant: k % 4, atMm: s.atMm, nudgeMm: s.nudgeMm });
        sensorCount++;
      });
    }
    emitDeadman(L, cx0 - half + 4, cy0 + half - 3, f, 'B', spine);
    emitHeader(L, cx0, cy0 + half - 3, f, 'B', [
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
      sensors: sensorCount,
    },
    contract,
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
export const FOOTPRINTS = {
  sop8: {
    // Includes the bundled 100n decap's two pads beside the chip, so the fit
    // verdict covers exactly what emitBridge8 places -- chip AND cap.
    label: 'SOP-8 bridge + 100n (MX1508-class)', body: [4.9, 3.9],
    pads: [-1.905, -0.635, 0.635, 1.905].flatMap((y) =>
      [[-2.7, y, 1.5, 0.6], [2.7, y, 1.5, 0.6]])
      .concat([[-0.5, 2.6, 0.4, 0.5], [0.5, 2.6, 0.4, 0.5]]),
  },
  dfn8: {
    label: '2x2 DFN bridge (DRV8837-class)', body: [2.2, 2.2],
    pads: [-0.75, -0.25, 0.25, 0.75].flatMap((y) =>
      [[-0.85, y, 0.6, 0.3], [0.85, y, 0.6, 0.3]]),
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
  const discs = [...plan.vias, ...plan.termVias].map((v) => ({ x: v.p[0], y: v.p[1], r: via / 2 }));
  const rects = (plan.termPads || []).map((p) => ({ cx: p.p[0], cy: p.p[1], w: p.w, h: p.h, ang: p.a }));
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
  const extent = { cx, cy, w: 2 * ex, h: 2 * ey, ang };
  if (!fp.sparse) {
    for (const [ox, oy] of obs.offsets) {
      if (rectsOverlap(extent, { ...extent, cx: cx + ox, cy: cy + oy })) return false;
    }
  }
  return true;
}

const ROTS = [0, Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3, 3 * Math.PI / 4, 5 * Math.PI / 6];

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
} = {}) {
  if (!isPcbCoil(cfg.stator.coilType)) return { available: false, reason: 'notpcb' };
  if (!(cfg.stator.pcbSpareLayers > 0)) return { available: false, reason: 'nolayer' };
  const obs = backsideObstacles(cfg);
  const parts = {};
  for (const [key, fp] of Object.entries(footprints)) {
    parts[key] = { label: fp.label, ...placeInCell(fp, obs, clearance) };
  }

  let sensors = null;
  if (stator && sensorSpacing) {
    const gridHalf = cfg.stator.statorSize / 2;
    const n = Math.floor((2 * gridHalf) / sensorSpacing) + 1;
    const placed = [];
    let failed = 0, worstNudge = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const wx = (-gridHalf + i * sensorSpacing) * 1000, wy = (-gridHalf + j * sensorSpacing) * 1000;
        // Local frame of the nearest coil: the obstacle plan is coil-local.
        let best = null, bd = Infinity;
        for (const c of stator.coils) {
          const d = Math.hypot(c.x * 1000 - wx, c.y * 1000 - wy);
          if (d < bd) { bd = d; best = c; }
        }
        let bi = 0;
        for (let k = 0; k < stator.coils.length; k++) {
          if (stator.coils[k] === best) { bi = k; break; }
        }
        const r = placeInCell(footprints.sot23_6, obs, clearance, nudgeMax, [wx - best.x * 1000, wy - best.y * 1000]);
        if (r.fits) {
          worstNudge = Math.max(worstNudge, r.offMm);
          // Anchor by (cell, local offset): the fit is proven in the coil-local
          // frame, so emission must re-apply the offset in that same frame.
          placed.push({
            coil: bi, local: [r.at[0], r.at[1]],
            atMm: [best.x * 1000 + r.at[0], best.y * 1000 + r.at[1]],
            nudgeMm: r.offMm,
          });
        } else { failed++; }
      }
    }
    sensors = { wanted: n * n, placed: placed.length, failed, worstNudgeMm: worstNudge, list: placed };
  }

  return {
    available: true,
    obstaclesPerCell: obs.discs.length + obs.rects.length,
    gutterMm: obs.pitchMm * (1 - cfg.stator.coilFill),
    holeMm: 2 * obs.g.halfIn,
    clearance, parts, sensors,
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
function emitShift595(L, ref, ox, oy, rot, f, S, n) {
  const m = S === 'B' ? ' (justify mirror)' : '';
  const PIN = [ // pin -> [function, local x, y] (TSSOP-16, pin 1 top-left, CCW)
    ['q1', -2.9, -2.275], ['q2', -2.9, -1.625], ['q3', -2.9, -0.975], ['q4', -2.9, -0.325],
    ['q5', -2.9, 0.325], ['q6', -2.9, 0.975], ['q7', -2.9, 1.625], ['gnd', -2.9, 2.275],
    ['q7s', 2.9, 2.275], ['mr', 2.9, 1.625], ['sclk', 2.9, 0.975], ['rclk', 2.9, 0.325],
    ['oen', 2.9, -0.325], ['ds', 2.9, -0.975], ['q0', 2.9, -1.625], ['vcc', 2.9, -2.275],
  ];
  const netFor = (fn) => {
    if (fn === 'mr') return n.vcc;                       // /MR tied high
    if (fn.startsWith('q') && fn.length <= 2 && fn !== 'q7s') return n.q[+fn.slice(1)] ?? { num: 0, name: '' };
    return n[fn] ?? { num: 0, name: '' };
  };
  L.push(`  (footprint "maglev:SR595" (layer "${S}.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "${ref}" (at 0 -3.1) (layer "${S}.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_text value "74HC595" (at 0 3.1) (layer "${S}.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_rect (start -2.5 -2.2) (end 2.5 2.2) (layer "${S}.CrtYd") (width 0.05))`);
  PIN.forEach(([fn, px, py], k) => {
    const net = netFor(fn);
    const [rx, ry] = rotXY(px, py, rot);
    L.push(fpPad(k + 1, f(rx), f(ry), 1.2, 0.4, net.num, net.name, S, f(rot)));
  });
  L.push('  )');
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
  L.push(fpPad(1, -0.95, 1.0, 0.6, 0.7, n.ng.num, n.ng.name, S));   // gate
  L.push(fpPad(2, 0.95, 1.0, 0.6, 0.7, n.gnd.num, n.gnd.name, S));  // source
  L.push(fpPad(3, 0, -1.0, 0.6, 0.7, n.oen.num, n.oen.name, S));    // drain
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
  const m = S === 'B' ? ' (justify mirror)' : '';
  L.push(`  (footprint "maglev:TMAG" (layer "${S}.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "${ref}" (at 0 -1.5) (layer "${S}.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
  L.push(`    (fp_text value "TMAG5273" (at 0 1.5) (layer "${S}.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05))${m}))`);
  const P = [ // [function, x, y] on the sot23_6 envelope
    ['scl', -1.1, -0.95], ['gnd', -1.1, 0], ['sda', -1.1, 0.95],
    ['int', 1.1, 0.95], ['vcc', 1.1, 0], ['nc', 1.1, -0.95],
  ];
  P.forEach(([fn, px, py], k) => {
    const net = n[fn] ?? { num: 0, name: '' };
    const [rx, ry] = rotXY(px, py, rot);
    L.push(fpPad(k + 1, f(rx), f(ry), 0.9, 0.6, net.num, net.name, S, f(rot)));
  });
  L.push('  )');
}

/** An integrated-bridge envelope on the fit-verified SOP-8 land pattern (pads
 *  land on the winding annulus). Function-named pads, not a specific part's
 *  pinout -- MX1508-class per the BOM. */
function emitBridge8(L, ref, ox, oy, rot, f, S, n) {
  const m = S === 'B' ? ' (justify mirror)' : '';
  L.push(`  (footprint "maglev:SOP8HB" (layer "${S}.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "${ref}" (at 0 -2.6) (layer "${S}.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_text value "MX1508-class" (at 0 2.6) (layer "${S}.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06))${m}))`);
  L.push(`    (fp_rect (start -2.45 -1.95) (end 2.45 1.95) (layer "${S}.CrtYd") (width 0.05))`);
  const P = [ // matches FOOTPRINTS.sop8 pad geometry
    ['in1', -2.7, -1.905], ['in2', -2.7, -0.635], ['vbus', -2.7, 0.635], ['gnd', -2.7, 1.905],
    ['outa', 2.7, -1.905], ['outb', 2.7, -0.635], ['gnd2', 2.7, 0.635], ['vbus2', 2.7, 1.905],
  ];
  const pad = (name, fn, px, py, w, h) => {
    const net = n[fn] ?? { num: 0, name: '' };
    const [rx, ry] = rotXY(px, py, rot);
    L.push(fpPad(name, f(rx), f(ry), w, h, net.num, net.name, S, f(rot)));
  };
  P.forEach(([fn, px, py], k) => pad(k + 1, fn === 'gnd2' ? 'gnd' : fn === 'vbus2' ? 'vbus' : fn, px, py, 1.5, 0.6));
  // The bundled 100n decap beside the chip (part of the fit envelope).
  pad('C1', 'vbus', -0.5, 2.6, 0.4, 0.5);
  pad('C2', 'gnd', 0.5, 2.6, 0.4, 0.5);
  L.push('  )');
}
