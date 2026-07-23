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

import { effectiveTrace } from './coils.js';

/** PCB coil geometry in millimetres, recomputed from cfg so it matches
 *  coils.js exactly (same perLayer formula, same effective trace) without
 *  importing the filament model, whose `inner` is a physics approximation, not
 *  the real trace path. */
export function pcbCoilGeometry(cfg) {
  const { coilPitch, coilFill, pcbTraceWidth, pcbCopperThickness, pcbLayers } = cfg.stator;
  const w = coilPitch * coilFill;
  const eff = effectiveTrace(pcbTraceWidth, pcbCopperThickness);
  const perLayer = Math.max(1, Math.floor((w * 0.25) / (eff * 2)));
  const halfOut = (w / 2) * 1000;
  const pitch = 2 * eff * 1000;               // trace + equal space
  const halfIn = halfOut - pitch * perLayer;  // >= w/4 by construction of perLayer
  return {
    w: w * 1000, halfOut, halfIn, pitch,
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

/** Points of one layer's spiral, relative to the coil centre, in mm.
 *  Even layers spiral inward (outer -> inner); odd layers spiral outward
 *  (inner -> outer). Because turns is an integer the run is a whole number of
 *  quarter-turns, so both ends land on corner 0: every inner end at (halfIn,
 *  -halfIn), every outer end at (halfOut, -halfOut). Those two points are where
 *  the layer-to-layer hops attach. */
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

// Which end of an edge layer is the free one (the terminal). Layer 0's inner end
// always goes to junction 0 (an inner hop), so its outer end is free. Layer N-1's
// free end is whichever end its last junction (N-2) did not consume.
function freeEndIsOuter(layer, N) {
  if (layer === 0) return true;
  return (N - 2) % 2 === 0; // last junction inner -> uses inner end -> outer free
}

/** Plan every through-hole for one coil, in coil-local millimetres. Returns tab
 *  segments (each tagged with its layer index), the via sites, terminal stubs,
 *  and counts. Same for every coil, so buildKiCad computes it once. */
function viaPlan(g, N, cellHalf, viaSize) {
  const P_in = corner(0, g.halfIn);            // every inner end lands here
  const P_out = corner(0, g.halfOut);          // every outer end lands here
  const pitchV = viaSize * 1.7;                // via centre-to-centre inside a farm
  const gutter = Math.max(cellHalf - g.halfOut, viaSize); // room outside the coil
  const off = Math.min(g.pitch, gutter) * 0.5; // how far into the gutter vias sit
  const holeR = Math.max(g.halfIn * 0.62, viaSize); // inner-via radius from centre
  const TARGET_FARM = 4;                        // outer vias per hop, space permitting

  const segments = [];                          // [x0,y0,x1,y1, layer]
  const vias = [];                              // [x,y]  (all through-hole)
  const terminals = [];                         // [x0,y0,x1,y1, layer]

  const innerJ = [], outerJ = [];
  for (let j = 0; j < N - 1; j++) (j % 2 === 0 ? innerJ : outerJ).push(j);

  // --- inner hops: one via each, fanned across the centre hole ---
  const iSpread = 2.6;                          // rad, fan around the corner-0 axis
  innerJ.forEach((j, k) => {
    const t = innerJ.length === 1 ? 0.5 : (k + 0.5) / innerJ.length;
    const ang = -Math.PI / 4 - iSpread / 2 + iSpread * t;
    const site = [holeR * Math.cos(ang), holeR * Math.sin(ang)];
    // Tab from the shared inner corner to the site, drawn on BOTH hop layers.
    segments.push([P_in[0], P_in[1], site[0], site[1], j]);
    segments.push([P_in[0], P_in[1], site[0], site[1], j + 1]);
    vias.push(site);
  });

  // --- outer hops + terminals: farms stacked up the right-edge gutter ---
  const termOuter = [0, N - 1].filter((l) => freeEndIsOuter(l, N));
  const slots = outerJ.length + termOuter.length;
  const x = g.halfOut + off;                    // just outside the right edge
  const yLo = -g.halfOut + off, yHi = g.halfOut - off;
  const slotH = slots > 0 ? (yHi - yLo) / slots : 0;
  const kOuter = Math.max(1, Math.min(TARGET_FARM,
    1 + Math.floor((slotH - viaSize) / pitchV)));
  let slot = 0;
  outerJ.forEach((j) => {
    const yc = yLo + slotH * (slot + 0.5); slot++;
    // Farm of kOuter vias stacked in y, centred on the slot.
    const y0 = yc - pitchV * (kOuter - 1) / 2;
    for (let m = 0; m < kOuter; m++) vias.push([x, y0 + pitchV * m]);
    // Tab from the shared outer corner up to the farm, on both hop layers, plus a
    // short strip through the farm so every via lands on copper of both layers.
    for (const layer of [j, j + 1]) {
      segments.push([P_out[0], P_out[1], x, yc, layer]);
      segments.push([x, y0, x, y0 + pitchV * (kOuter - 1), layer]);
    }
  });

  // --- terminals: a stub from the free end out to the gutter (no via) ---
  for (const layer of [0, N - 1]) {
    if (freeEndIsOuter(layer, N)) {
      const yc = yLo + slotH * (slot + 0.5); slot++;
      terminals.push([P_out[0], P_out[1], x, yc, layer]);
    } else {
      // Rare (odd N): inner free end -> stub straight into the hole.
      terminals.push([P_in[0], P_in[1], 0, 0, layer]);
    }
  }

  return {
    segments, vias, terminals,
    counts: { inner: innerJ.length, outer: outerJ.length * kOuter, kOuter, perCoil: vias.length },
  };
}

// One SMD pad of a back-side footprint, on a given net. Coordinates are
// footprint-relative (mm); KiCad places them against the footprint origin.
function fpPad(n, px, py, w, h, netNum, netName) {
  return `    (pad "${n}" smd rect (at ${px} ${py}) (size ${w} ${h}) (layers "B.Cu" "B.Paste" "B.Mask") (net ${netNum} "${netName}"))`;
}

/** An integrated H-bridge power stage (VBUS, GND, two outputs to the coil, two
 *  PWM inputs) as a ~2 mm back-side footprint at (ox, oy). Both outputs sit on
 *  the coil net -- the winding is the bridge's load. */
function emitPowerStage(L, ci, ox, oy, f, coilNet, vbus, gnd, pa, pb) {
  L.push(`  (footprint "maglev:HB6" (layer "B.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "U${ci}" (at 0 -1.35) (layer "B.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06)) (justify mirror)))`);
  L.push(`    (fp_text value "HB6" (at 0 1.35) (layer "B.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06)) (justify mirror)))`);
  L.push('    (fp_rect (start -1 -1) (end 1 1) (layer "B.CrtYd") (width 0.05))');
  L.push(fpPad(1, -0.9, -0.65, 0.5, 0.3, vbus, 'VBUS'));
  L.push(fpPad(2, -0.9, 0, 0.5, 0.3, gnd, 'GND'));
  L.push(fpPad('3', -0.9, 0.65, 0.5, 0.3, coilNet, `coil_${ci}`));   // OUTA
  L.push(fpPad('4', 0.9, -0.65, 0.5, 0.3, coilNet, `coil_${ci}`));   // OUTB
  L.push(fpPad('5', 0.9, 0, 0.5, 0.3, pa, `PWMA_${ci}`));
  L.push(fpPad('6', 0.9, 0.65, 0.5, 0.3, pb, `PWMB_${ci}`));
  L.push('  )');
}

/** A 0402 decoupling cap across VBUS/GND next to a power stage. */
function emitDecap(L, ci, ox, oy, f, vbus, gnd) {
  L.push(`  (footprint "maglev:C0402" (layer "B.Cu") (at ${f(ox)} ${f(oy)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "C${ci}" (at 0 -0.6) (layer "B.SilkS") (effects (font (size 0.3 0.3) (thickness 0.05)) (justify mirror)))`);
  L.push(`    (fp_text value "100n" (at 0 0.6) (layer "B.Fab") hide (effects (font (size 0.3 0.3) (thickness 0.05)) (justify mirror)))`);
  L.push('    (fp_rect (start -0.55 -0.35) (end 0.55 0.35) (layer "B.CrtYd") (width 0.05))');
  L.push(fpPad(1, -0.5, 0, 0.4, 0.5, vbus, 'VBUS'));
  L.push(fpPad(2, 0.5, 0, 0.4, 0.5, gnd, 'GND'));
  L.push('  )');
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

  // --- nets ---
  // One signal net per coil, then the shared power rails and a per-coil PWM pair
  // for the on-board driver array (an H-bridge per coil -- see below). The coil
  // spiral is the H-bridge's inductive load, so BOTH bridge outputs land on the
  // coil's own net: at DC the winding is a short, which is exactly what an
  // H-bridge across an inductor looks like, and it keeps every coil an isolated
  // island (no shared star to merge them). Power is the only thing they share.
  const C = stator.coils.length;
  const drivers = cfg.stator.pcbDrivers !== false;
  const netGND = C + 1, netVBUS = C + 2;
  const pwmA = (i) => C + 3 + 2 * i;
  const pwmB = (i) => C + 3 + 2 * i + 1;
  L.push('  (net 0 "")');
  stator.coils.forEach((_, i) => L.push(`  (net ${i + 1} "coil_${i}")`));
  if (drivers) {
    L.push(`  (net ${netGND} "GND")`);
    L.push(`  (net ${netVBUS} "VBUS")`);
    stator.coils.forEach((_, i) => {
      L.push(`  (net ${pwmA(i)} "PWMA_${i}")`);
      L.push(`  (net ${pwmB(i)} "PWMB_${i}")`);
    });
  }

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
    const tx = (p0) => f(ox + p0);
    const ty = (p1) => f(oy + p1);

    // The spiral tracks, layer by layer.
    for (let j = 0; j < N; j++) {
      const pts = layerPts[j];
      const layer = cuName(j, N);
      for (let s = 0; s < pts.length - 1; s++) {
        L.push(`  (segment (start ${tx(pts[s][0])} ${ty(pts[s][1])}) (end ${tx(pts[s + 1][0])} ${ty(pts[s + 1][1])}) (width ${f(g.trace)}) (layer "${layer}") (net ${net}))`);
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
    // Two terminals so a lead can land on the stack ends.
    for (const [x0, y0, x1, y1, layer] of plan.terminals) {
      L.push(`  (segment (start ${tx(x0)} ${ty(y0)}) (end ${tx(x1)} ${ty(y1)}) (width ${f(g.trace)}) (layer "${cuName(layer, N)}") (net ${net}))`);
      segments++;
    }

    // The on-board amplifier: one integrated H-bridge power stage per coil, on
    // the back, in the coil's centre hole -- the only clear real estate on an
    // all-copper board -- plus a local decoupling cap. Its outputs drive the
    // coil (net coil_i); it draws from the shared VBUS/GND rails and takes a
    // per-coil PWM pair. This is what makes the independent-grouping analysis
    // buildable: 324 drivers etched under 324 spirals instead of a wiring loom.
    if (drivers) {
      emitPowerStage(L, ci, ox, oy, f, net, netVBUS, netGND, pwmA(ci), pwmB(ci));
      emitDecap(L, ci, ox + 1.7, oy, f, netVBUS, netGND);
      // Tie one bridge output to the coil: a short back-side track from the
      // output pad to the nearest inner via, which is already on the coil net.
      const ov = plan.vias[0];
      L.push(`  (segment (start ${tx(ov[0])} ${ty(ov[1])}) (end ${tx(-0.9)} ${ty(0.65)}) (width ${f(g.trace)}) (layer "${cuName(N - 1, N)}") (net ${net}))`);
      segments++;
    }
  }

  L.push(')');
  return {
    text: L.join('\n') + '\n',
    stats: {
      coils: stator.coils.length, layers: N, turnsPerLayer: g.turns,
      segments, vias, viasPerCoil: plan.counts.perCoil,
      innerVias: plan.counts.inner, outerVias: plan.counts.outer,
      viasPerHop: plan.counts.kOuter, viaTech: 'through-hole (plated)',
      nets: stator.coils.length, boardMm: S, traceMm: g.trace,
      // On-board amplifier array: one H-bridge power stage + one decoupling cap
      // per coil, so the board is a distributed inverter, not a passive coil pad.
      drivers: drivers ? C : 0, decaps: drivers ? C : 0,
      driverTopology: drivers ? 'H-bridge per coil (independent)' : 'none',
      powerNets: drivers ? 2 + 2 * C : 0,
    },
  };
}
