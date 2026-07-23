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
    turns: perLayer, layers: pcbLayers,
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
  const N = cfg.stator.pcbLayers;
  const g = pcbCoilGeometry(cfg);
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
  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      drivers, decaps, mating, layers: 2, coils: C, boardMm: 2 * half,
      driverTopology: 'H-bridge per coil (independent)',
      nets: 2 + 4 * C,
    },
  };
}

/** Build a complete .kicad_pcb for the PCB stator. Returns { text, stats } or
 *  null when the coil type is not a PCB (nothing to fabricate as copper). */
export function buildKiCad(stator, cfg) {
  if (!isPcbCoil(cfg.stator.coilType)) return null;

  const N = cfg.stator.pcbLayers;
  const g = pcbCoilGeometry(cfg);
  const S = cfg.stator.statorSize * 1000;             // nominal stator, mm
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const drill = via * 0.5;
  const cellHalf = cfg.stator.coilPitch * 1000 / 2;
  const half = boardHalf(g, stator, S, cellHalf);     // grows to contain hex-packed rim coils
  const cx0 = half + 10, cy0 = half + 10;             // keep all coords positive
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
  const edge = [[-half, -half], [half, -half], [half, half], [-half, half]];
  for (let e = 0; e < 4; e++) {
    const a = edge[e], b = edge[(e + 1) % 4];
    L.push(`  (gr_line (start ${f(cx0 + a[0])} ${f(cy0 + a[1])}) (end ${f(cx0 + b[0])} ${f(cy0 + b[1])}) (layer "Edge.Cuts") (width 0.1))`);
  }

  // --- coils ---
  let segments = 0, vias = 0, termPads = 0;
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

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      coils: stator.coils.length, layers: N, turnsPerLayer: g.turns,
      segments, vias, viasPerCoil: plan.counts.perCoil,
      innerVias: plan.counts.inner, outerVias: plan.counts.outer,
      viaTech: 'through-hole (plated)', cornerVias: true,
      termPads, termPadsPerCoil: (plan.termPads || []).length,
      nets: stator.coils.length, boardMm: 2 * half, traceMm: g.trace,
      drivers: 0, driverTopology: 'backplane (separate board)',
    },
  };
}
