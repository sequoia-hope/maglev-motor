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
  const cr = g.corner ?? 0;
  // Only the outermost turn touches the cell-corner pockets, so round just the
  // outer ~1.5 turns. The inner turns stay sharp -- rounding them all would
  // multiply the feature count (and the file size) for no pocket benefit.
  const roundR = g.halfOut - g.pitch * 1.5;
  const prims = [];
  let from = V[0];
  for (let i = 1; i < V.length - 1; i++) {
    const A = V[i - 1], P = V[i], B = V[i + 1];
    const dinx = P[0] - A[0], diny = P[1] - A[1], lin = Math.hypot(dinx, diny);
    const dox = B[0] - P[0], doy = B[1] - P[1], lout = Math.hypot(dox, doy);
    const inOuter = Math.max(Math.abs(P[0]), Math.abs(P[1])) > roundR;
    const s = inOuter ? Math.min(cr, lin * 0.5, lout * 0.5) : 0;
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
function viaPlan(g, N, cellHalf, viaSize) {
  const P_in = corner(0, g.halfIn);            // every inner end lands here
  const P_out = corner(0, g.halfOut);          // every outer end lands here
  const holeR = Math.max(g.halfIn * 0.58, viaSize * 0.7);   // inner-via radius
  const gutR = g.halfOut + Math.min(g.corner * 0.5,
    Math.max(cellHalf - g.halfOut, viaSize) * 0.55);        // perimeter tab radius
  const step = viaSize * 1.5;                   // via spread inside a corner pocket

  const segments = [];                          // [x0,y0,x1,y1, layer]
  const vias = [];                              // [x,y]  crossover through-holes
  const terminals = [];                         // [x0,y0,x1,y1, layer]
  const termVias = [];                          // [x,y]  backplane mating vias

  const innerJ = [], outerJ = [];
  for (let j = 0; j < N - 1; j++) (j % 2 === 0 ? innerJ : outerJ).push(j);

  // Inner hops: one via each, fanned across the (now small) centre hole.
  const iSpread = 2.2;
  innerJ.forEach((j, k) => {
    const t = innerJ.length === 1 ? 0.5 : (k + 0.5) / innerJ.length;
    const ang = -Math.PI / 4 - iSpread / 2 + iSpread * t;
    const site = [holeR * Math.cos(ang), holeR * Math.sin(ang)];
    segments.push([P_in[0], P_in[1], site[0], site[1], j]);
    segments.push([P_in[0], P_in[1], site[0], site[1], j + 1]);
    vias.push(site);
  });

  // A gutter waypoint just outside cell corner ci, and the tab path from the
  // coil's outer end around the shorter way to a target via.
  const gp = (ci) => corner(ci, gutR);
  const tabPath = (ci, target) => {
    const pts = [P_out, gp(0)];
    const ccw = ci, cw = (4 - ci) % 4;
    if (ci !== 0) {
      if (ccw <= cw) for (let c = 1; c <= ci; c++) pts.push(gp(c % 4));
      else for (let c = 1; c <= cw; c++) pts.push(gp((4 - c) % 4));
    }
    pts.push(target);
    return pts;
  };

  // Assign outer crossovers round-robin to the 4 corners, terminals to opposite
  // corners; then spread the vias that share a pocket along that corner's diagonal.
  const items = outerJ.map((j, k) => ({ layers: [j, j + 1], ci: k % 4, kind: 'hop' }));
  [0, N - 1].filter((l) => freeEndIsOuter(l, N))
    .forEach((l, idx) => items.push({ layers: [l], ci: idx === 0 ? 0 : 2, kind: 'term' }));
  const cnt = [0, 0, 0, 0];
  items.forEach((it) => { it.slot = cnt[it.ci]++; });
  items.forEach((it) => {
    const n = cnt[it.ci];
    const r = g.halfOut + (it.slot - (n - 1) / 2) * step;   // spread in the pocket
    const via = corner(it.ci, r);
    const path = tabPath(it.ci, via);
    const bucket = it.kind === 'hop' ? segments : terminals;
    for (const layer of it.layers)
      for (let q = 0; q < path.length - 1; q++)
        bucket.push([path[q][0], path[q][1], path[q + 1][0], path[q + 1][1], layer]);
    (it.kind === 'hop' ? vias : termVias).push(via);
  });
  // Odd-N corner case: an inner free end just stubs into the hole.
  for (const layer of [0, N - 1]) if (!freeEndIsOuter(layer, N)) terminals.push([P_in[0], P_in[1], 0, 0, layer]);

  return {
    segments, vias, terminals, termVias,
    counts: { inner: innerJ.length, outer: outerJ.length, perCoil: vias.length + termVias.length },
  };
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
    plan.termVias.forEach((tv, k) => {
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
    for (const [x, y] of plan.vias) {
      L.push(`  (via (at ${tx(x)} ${ty(y)}) (size ${f(via)}) (drill ${f(drill)}) (layers "${thVia[0]}" "${thVia[1]}") (net ${net}))`);
      vias++;
    }
    // Terminal stubs to the corner pockets, and a mating via at each so the
    // backplane connector can pick the two coil ends up.
    for (const [x0, y0, x1, y1, layer] of plan.terminals) {
      L.push(`  (segment (start ${tx(x0)} ${ty(y0)}) (end ${tx(x1)} ${ty(y1)}) (width ${f(g.trace)}) (layer "${cuName(layer, N)}") (net ${net}))`);
      segments++;
    }
    for (const [x, y] of plan.termVias) {
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
