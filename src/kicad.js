// Export the PCB stator as a real .kicad_pcb file -- actual copper spirals on an
// N-layer board, not a picture of one. The board that comes out is the board the
// physics was run on: the coil pitch, trace width, layer count and turns-per-
// layer all come from the same cfg makeStator() reads, so the exported copper
// carries the same current geometry the wrench matrix integrated over.
//
// The one thing that has to be right, and is the easy thing to get wrong, is the
// winding sense. A multilayer spiral is a series stack: current spirals inward on
// one layer, vias down, spirals back outward on the next. If the outward layer
// winds the opposite way round, its field OPPOSES the layer above it and the two
// cancel -- so a 12-layer board would make the field of far fewer. Every layer
// here traverses its corners in the same rotational order (CCW seen from +z)
// regardless of whether it is spiralling in or out, so every layer's azimuthal
// current runs the same way and the fields add. test/kicad.test.mjs checks it by
// the sign of each layer's enclosed area.

/** PCB coil geometry in millimetres, recomputed from cfg so it matches
 *  coils.js exactly (same perLayer formula) without importing the filament
 *  model, whose `inner` is a physics approximation, not the real trace path. */
export function pcbCoilGeometry(cfg) {
  const { coilPitch, coilFill, pcbTraceWidth, pcbLayers } = cfg.stator;
  const w = coilPitch * coilFill;
  const perLayer = Math.max(1, Math.floor((w * 0.25) / (pcbTraceWidth * 2)));
  const halfOut = (w / 2) * 1000;
  const pitch = 2 * pcbTraceWidth * 1000;     // trace + equal space
  const halfIn = halfOut - pitch * perLayer;  // >= w/4 by construction of perLayer
  return {
    w: w * 1000, halfOut, halfIn, pitch,
    turns: perLayer, layers: pcbLayers,
    trace: pcbTraceWidth * 1000,
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

/** Points of one layer's spiral, relative to the coil centre, in mm.
 *  Even layers spiral inward (outer -> inner); odd layers spiral outward
 *  (inner -> outer). Because turns is an integer the run is a whole number of
 *  quarter-turns, so both ends land on corner 0 and the inter-layer via is a
 *  single point shared by the two layers. */
export function spiralPoints(g, layerIndex) {
  const inward = layerIndex % 2 === 0;
  const n = g.turns * 4;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const r = inward ? g.halfOut - (g.pitch / 4) * i : g.halfIn + (g.pitch / 4) * i;
    pts.push(corner(i, r));
  }
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

  // --- nets: one per coil ---
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
  const layerPts = Array.from({ length: N }, (_, j) => spiralPoints(g, j));
  for (let ci = 0; ci < stator.coils.length; ci++) {
    const c = stator.coils[ci];
    const net = ci + 1;
    // Sim centres are metres, board centred on origin; flip y for KiCad's
    // y-down page so the exported array reads the same way up as the render.
    const ox = cx0 + c.x * 1000, oy = cy0 - c.y * 1000;
    const tx = (p) => f(ox + p[0]);
    const ty = (p) => f(oy + p[1]);

    for (let j = 0; j < N; j++) {
      const pts = layerPts[j];
      const layer = cuName(j, N);
      for (let s = 0; s < pts.length - 1; s++) {
        L.push(`  (segment (start ${tx(pts[s])} ${ty(pts[s])}) (end ${tx(pts[s + 1])} ${ty(pts[s + 1])}) (width ${f(g.trace)}) (layer "${layer}") (net ${net}))`);
        segments++;
      }
      // Buried via to the next layer, at the corner where the two layers meet:
      // inner corner after an inward (even) layer, outer corner after an outward
      // (odd) one -- which is exactly the last point of this layer's run.
      if (j < N - 1) {
        const v = pts[pts.length - 1];
        L.push(`  (via (at ${tx(v)} ${ty(v)}) (size ${f(via)}) (drill ${f(drill)}) (layers "${cuName(j, N)}" "${cuName(j + 1, N)}") (net ${net}))`);
        vias++;
      }
    }

    // Two terminals at the outer corner, stubbed clear of the winding so a lead
    // can land: the very first point (top layer) and the last layer's end.
    const outer = corner(0, g.halfOut);
    const stub = [outer[0] + g.pitch, outer[1]];
    L.push(`  (segment (start ${tx(outer)} ${ty(outer)}) (end ${tx(stub)} ${ty(stub)}) (width ${f(g.trace)}) (layer "${cuName(0, N)}") (net ${net}))`);
    L.push(`  (segment (start ${tx(outer)} ${ty(outer)}) (end ${tx(stub)} ${ty(stub)}) (width ${f(g.trace)}) (layer "${cuName(N - 1, N)}") (net ${net}))`);
    segments += 2;
  }

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      coils: stator.coils.length, layers: N, turnsPerLayer: g.turns,
      segments, vias, nets: stator.coils.length,
      boardMm: S, traceMm: g.trace,
    },
  };
}
