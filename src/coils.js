// Stator coil geometry. Every coil is reduced to a set of straight current
// filaments; the Lorentz integral in physics.js is then just a sum over
// segments. Multi-turn windings are represented by a few concentric filament
// rings so the finite winding-window width is captured rather than lumping all
// turns onto one path.

const CU_RESISTIVITY = 1.68e-8; // ohm-m at 20 C
// Copper fraction of the winding window for round wire. ~0.7 is good layer
// winding; hand-wound scramble windings are nearer 0.5.
const PACKING = 0.7;
// Multilayer board stackup. Prepreg/core between adjacent copper layers, plus
// soldermask on the outer faces. 0.1 mm is about as thin as a fab will press a
// dielectric on a high-layer-count job; it is what makes a 32-layer board over
// 3 mm thick no matter how you ask for it.
const PCB_DIELECTRIC = 0.1e-3;
const PCB_MASK = 25e-6;

// Heavy copper cannot be etched into thin tracks: the thicker the plating, the
// wider a trace the fab needs to hold the etch. Carl Bugeja's 12-layer coil ran
// straight into this -- his 4 mil design could only be poured in 1 oz copper,
// and 2 oz forced him out to 8 mil. So the minimum trace width scales with copper
// weight at ~4 mil per ounce (his stated fab rule), and the width the coil is
// ACTUALLY built with is the wider of what you asked for and what the copper
// allows. This is why you cannot buy turns by piling on copper weight at a fixed
// trace width: past the balance point the mandatory wider track eats the turns
// faster than the extra layers add them.
const OZ_COPPER = 34.79e-6; // m, thickness of 1 oz/ft^2 finished copper
const MIL = 25.4e-6;        // m
export function minTrackWidth(copperThickness) {
  return 4 * MIL * (copperThickness / OZ_COPPER); // Bugeja's 4 mil/oz fab rule
}
/** The trace a PCB coil is really manufactured with: never narrower than the
 *  copper weight permits. coils.js and kicad.js both route through this so the
 *  exported copper and the simulated coil can never disagree on turn count. */
export function effectiveTrace(traceWidth, copperThickness) {
  return Math.max(traceWidth, minTrackWidth(copperThickness));
}

// How much of the coil half-width the winding leaves clear at the centre. The
// first cut left a full quarter (a big dead hole); winding closer to the middle
// packs several more turns per layer straight into force. We keep a small centre
// clear for the inner via cluster -- the layer-to-layer crossovers that must
// stay near the centre because they cannot be routed out past the winding.
const PCB_INNER_FRAC = 0.13;
/** Turns per layer for a PCB spiral of half-width w/2 at effective trace `eff`.
 *  Shared by coils.js (physics) and kicad.js (copper) so they cannot diverge. */
export function pcbTurnsPerLayer(w, eff, innerFrac = PCB_INNER_FRAC) {
  return Math.max(1, Math.floor((w * (0.5 - innerFrac)) / (eff * 2)));
}

/** Pressed thickness of an N-layer board: the one stackup formula, shared so
 *  the physics (makeStator), the mechanical stack table and the thermal-growth
 *  term cannot quote three different boards. */
export function pcbBoardThickness(pcbLayers, pcbCopperThickness) {
  return pcbLayers * pcbCopperThickness
    + (pcbLayers - 1) * PCB_DIELECTRIC + 2 * PCB_MASK;
}

/** Discretise one regular-polygon winding into filament segments -- the round/
 *  hexagonal analogue of rectFilaments, used by the honeycomb PCB coil. Vertices
 *  sit on a circle of the given circumradius at `phase + k*(2pi/nSides)`, walked
 *  CCW (increasing angle) so the field adds the same way the rectangular loop's
 *  does. A large nSides approximates a round coil; 6 is the hexagon. */
function polyFilaments(circumOuter, circumInner, turns, rings, nSides, phase, perSide) {
  const mid = [];
  const dl = [];
  const turnsPerRing = turns / rings;
  const step = (2 * Math.PI) / nSides;
  for (let r = 0; r < rings; r++) {
    const t = rings === 1 ? 0.5 : r / (rings - 1);
    const rad = circumInner + (circumOuter - circumInner) * t;
    for (let k = 0; k < nSides; k++) {
      const a0 = phase + k * step, a1 = phase + (k + 1) * step;
      const A = [rad * Math.cos(a0), rad * Math.sin(a0)];
      const B = [rad * Math.cos(a1), rad * Math.sin(a1)];
      for (let s = 0; s < perSide; s++) {
        const u0 = s / perSide, u1 = (s + 1) / perSide;
        const p0 = [A[0] + (B[0] - A[0]) * u0, A[1] + (B[1] - A[1]) * u0];
        const p1 = [A[0] + (B[0] - A[0]) * u1, A[1] + (B[1] - A[1]) * u1];
        mid.push((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, 0);
        dl.push((p1[0] - p0[0]) * turnsPerRing, (p1[1] - p0[1]) * turnsPerRing, 0);
      }
    }
  }
  return { mid: Float64Array.from(mid), dl: Float64Array.from(dl), n: mid.length / 3 };
}

/** Discretise one rectangular winding into filament segments.
 *  Returns {mid:Float64Array(3*n), dl:Float64Array(3*n)} in coil-local coords
 *  (origin at coil centre, z at the coil mid-plane). dl already carries the
 *  turns-per-ring factor, so a segment sum gives force per ampere of TERMINAL
 *  current. */
function rectFilaments(outer, inner, turns, rings, perSide) {
  const mid = [];
  const dl = [];
  const turnsPerRing = turns / rings;
  for (let r = 0; r < rings; r++) {
    const t = rings === 1 ? 0.5 : r / (rings - 1);
    const sx = inner[0] + (outer[0] - inner[0]) * t;
    const sy = inner[1] + (outer[1] - inner[1]) * t;
    const hx = sx / 2, hy = sy / 2;
    // Counter-clockwise loop: +x edge going +y, +y edge going -x, etc.
    const corners = [
      [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy],
    ];
    for (let c = 0; c < 4; c++) {
      const a = corners[c];
      const b = corners[(c + 1) % 4];
      for (let s = 0; s < perSide; s++) {
        const t0 = s / perSide, t1 = (s + 1) / perSide;
        const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
        const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
        mid.push((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, 0);
        dl.push((p1[0] - p0[0]) * turnsPerRing, (p1[1] - p0[1]) * turnsPerRing, 0);
      }
    }
  }
  return { mid: Float64Array.from(mid), dl: Float64Array.from(dl), n: mid.length / 3 };
}

function windingResistance(outer, inner, turns, wireArea) {
  const meanPerimeter = 2 * ((outer[0] + inner[0]) / 2 + (outer[1] + inner[1]) / 2);
  return (CU_RESISTIVITY * meanPerimeter * turns) / Math.max(wireArea, 1e-12);
}

/** A PCB stator, square-grid OR honeycomb. Both are multilayer spirals on a
 *  fabricated board -- same turns-from-layers model, same board-thickness
 *  stackup, same KiCad export, same "no winding to hide, drivers per coil" cost.
 *  The whole app gates PCB-specific behaviour on this, so the hex variant inherits
 *  every PCB code path instead of re-plumbing each one. */
export function isPcbCoil(coilType) {
  return coilType === 'pcb' || coilType === 'pcbhex';
}

export const COIL_TYPES = {
  square: {
    label: 'Square coils (grid)',
    note: 'Zhu/Teo/Pang topology. Each coil is an independent phase, so a square grid gives full x/y symmetry — at the cost of one driver channel per coil. Check the coil count before assuming you can build it.',
  },
  racetrack: {
    label: 'Racetrack coils (two orthogonal banks)',
    note: 'Jansen/ASML topology. Two orthogonal banks of segmented rectangular coils. Far fewer channels for the same stroke, but each coil is only well coupled to part of the platen, so hover power runs high.',
  },
  pcb: {
    label: 'PCB spiral coils (grid)',
    note: 'No winding to do: spirals on a multilayer board, tiled edge-to-edge to extend stroke. Few turns per unit area, so it needs a small air gap — and you still need a driver or switching matrix per coil.',
  },
  pcbhex: {
    label: 'PCB hex coils (honeycomb)',
    note: 'The same multilayer through-hole spirals as the PCB grid, but hexagonal and packed on a triangular lattice — six neighbours per coil instead of four. Hex packing is the densest tiling of round-ish coils, and the extra neighbour directions make the force more isotropic: the ripple as the platen slides diagonally no longer sees the gaps a square grid leaves at its corners. Same board, same driver-per-coil cost; watch the capability map even out versus the square grid.',
  },
};

/** Build the stator.
 *  All coils lie in a plane at z = 0; the translator flies above them. */
export function makeStator(cfg) {
  const {
    coilType, coilPitch, coilFill, statorSize,
    windingHeight, wireDiameter, pcbLayers, pcbTraceWidth, pcbCopperThickness,
    pcbSpareLayers = 0,
    ringsPerCoil = 2, segmentsPerSide = 4,
  } = cfg;

  const coils = [];
  // Hard cap on coil count: every coil carries filament geometry, and a
  // 150x150 grid would lock the tab up before it ever rendered.
  const MAX_SIDE = 48;
  const nWanted = Math.max(1, Math.round(statorSize / coilPitch));
  const nSide = Math.min(nWanted, MAX_SIDE);
  const truncated = nSide < nWanted;
  const span = (nSide - 1) * coilPitch;

  let outer, inner, effTurns, wireArea, thickness;
  let pcbEffTrace = null;
  let coilZ = null;

  if (isPcbCoil(coilType)) {
    // A spiral on an N-layer board. Turns per layer is set by how many
    // concentric traces fit in half the coil width -- but at the effective trace
    // width, which the copper weight can force wider than requested (Bugeja's
    // fab rule). Piling on copper thus does NOT monotonically buy turns.
    const w = coilPitch * coilFill;
    const eff = effectiveTrace(pcbTraceWidth, pcbCopperThickness);
    pcbEffTrace = eff;
    const perLayer = pcbTurnsPerLayer(w, eff);
    // Spare layers are copper given to ELECTRONICS, not turns: a driver-per-coil
    // board that carries its bridges and flux sensors on the bottom face needs
    // the bottom layer(s) free of winding. The board is still pressed at the
    // full layer count -- thickness (and so the magnet-to-copper distances and
    // the sensor attenuation) do not change -- but only the top
    // (pcbLayers - spare) layers wind, so the turns drop and the surviving
    // copper's centroid sits HIGHER in the stack, slightly closer to the magnets.
    const coilLayers = Math.max(1, pcbLayers - pcbSpareLayers);
    effTurns = perLayer * coilLayers;
    outer = [w, w];
    // Inner half-width is where the winding actually stops after an integer
    // number of turns -- matched to the copper so the force integral sees the
    // real hole, not a nominal one.
    const halfInM = Math.max(w * 0.5 - perLayer * 2 * eff, w * 0.05);
    inner = [2 * halfInM, 2 * halfInM];
    wireArea = eff * pcbCopperThickness;
    // Board thickness is DERIVED from the stackup, not assumed to be 1.6 mm.
    // Layers are the only knob that buys turns on a PCB stator, so if the board
    // never gets thicker, adding layers is free force -- the optimiser walks
    // straight to 32 layers and reports lift the board cannot deliver. In
    // reality every layer pushes the copper centroid further from the magnets,
    // and the field it sits in falls off as exp(-2*pi*z/lambda).
    thickness = pcbBoardThickness(pcbLayers, pcbCopperThickness);
    // Centroid of the winding copper: layers 1..coilLayers counted from the top
    // face. With no spare layers this is exactly -thickness/2 (the old value);
    // with spare layers the winding centroid rises by half the vacated stack.
    coilZ = -(PCB_MASK
      + (coilLayers * pcbCopperThickness + (coilLayers - 1) * PCB_DIELECTRIC) / 2);
  } else {
    // Turn count is DERIVED from geometry, never assumed. A winding only holds
    // as many turns as fit in its window: (window area x packing) / wire area.
    // Letting the user name a turn count directly is how you end up "designing"
    // a 12 mm coil that would physically be 96 mm tall and report a lift margin
    // it can never deliver.
    const w = coilPitch * coilFill;
    outer = [w, w];
    inner = [w * 0.45, w * 0.45];
    wireArea = Math.PI * (wireDiameter / 2) ** 2;
    const windowW = (outer[0] - inner[0]) / 2;   // radial width of the bundle
    const windowH = windingHeight;               // build height off the board
    effTurns = Math.max(1, Math.floor((PACKING * windowW * windowH) / wireArea));
    thickness = windowH;
  }

  // The winding window is a constant width around the perimeter, so a long
  // racetrack keeps a long opening instead of collapsing to a square hole.
  const mkCoil = (cx, cy, ox, oy, ang) => {
    const o = [ox, oy];
    const t = Math.min(ox, oy) * (1 - inner[0] / outer[0]);
    const i = [Math.max(ox - t, ox * 0.1), Math.max(oy - t, oy * 0.1)];
    const fil = rectFilaments(o, i, effTurns, ringsPerCoil, segmentsPerSide);
    // Coils hang BELOW z = 0, so the stator's top surface is the z = 0 plane
    // and the quoted air gap is the real clearance between magnet face and
    // copper. Getting this wrong lets a thick winding stack swallow the platen.
    return {
      x: cx, y: cy, z: coilZ ?? -thickness / 2, angle: ang,
      outer: o, inner: i, turns: effTurns,
      R: windingResistance(o, i, effTurns, wireArea),
      fil,
      current: 0,
    };
  };

  // A hexagonal PCB coil: a flat winding whose outline is a regular hexagon,
  // sized so its flat-to-flat width is the same w = coilPitch*coilFill the square
  // coil uses (so the turns-from-layers count is identical). apothem = w/2 is the
  // centre-to-flat depth the winding fills; the vertices sit at circumradius
  // apothem/cos(30 deg). Pointy-top orientation (a vertex at the top, phase 30
  // deg) so the coils nest into the honeycomb with their flats facing neighbours.
  const mkHexCoil = (cx, cy) => {
    const c30 = Math.cos(Math.PI / 6);
    const circumOut = (outer[0] / 2) / c30;   // outer[0]/2 = apothem = w/2
    const circumIn = (inner[0] / 2) / c30;
    const fil = polyFilaments(circumOut, circumIn, effTurns, ringsPerCoil, 6, Math.PI / 6, segmentsPerSide);
    // Hexagon perimeter = 6 * side, and side = circumradius for a hexagon.
    const meanR = (circumOut + circumIn) / 2;
    const R = (CU_RESISTIVITY * 6 * meanR * effTurns) / Math.max(wireArea, 1e-12);
    // Outline vertices (pointy-top hexagon, local coords) so the renderer can draw
    // the real coil shape instead of a bounding square.
    const hexPoly = (rad) => Array.from({ length: 6 }, (_, k) => {
      const a = Math.PI / 6 + k * (Math.PI / 3);
      return [rad * Math.cos(a), rad * Math.sin(a)];
    });
    return {
      x: cx, y: cy, z: coilZ ?? -thickness / 2, angle: 0,
      outer: [2 * circumOut, 2 * circumOut], inner: [2 * circumIn, 2 * circumIn],
      poly: hexPoly(circumOut), polyInner: hexPoly(circumIn),
      turns: effTurns, R, fil, current: 0,
    };
  };

  if (coilType === 'pcbhex') {
    // Honeycomb (triangular) lattice: rows spaced by pitch*sqrt(3)/2, alternate
    // rows shifted a quarter pitch each way so the array stays symmetric about
    // the centre. Every coil then has six nearest neighbours at exactly coilPitch,
    // which is the packing the isotropy comes from.
    const dv = coilPitch * Math.sqrt(3) / 2;
    const nRows = Math.min(MAX_SIDE, Math.max(1, Math.round(statorSize / dv)));
    const nCols = nSide;                       // = min(round(size/pitch), MAX_SIDE)
    const spanY = (nRows - 1) * dv;
    const rowSpan = (nCols - 1) * coilPitch;
    for (let j = 0; j < nRows; j++) {
      const off = (j % 2 ? 1 : -1) * coilPitch / 4;
      const y = -spanY / 2 + j * dv;
      for (let i = 0; i < nCols; i++) {
        coils.push(mkHexCoil(-rowSpan / 2 + off + i * coilPitch, y));
      }
    }
  } else if (coilType === 'racetrack') {
    // Two orthogonal banks, each SEGMENTED along its long axis. The
    // segmentation matters: with coils running the full width of the stator,
    // every coil's force is uniform along its length, and yaw torque becomes
    // structurally uncontrollable -- the wrench matrix drops to rank 5. Real
    // racetrack stators are built as blocks of finite-length coils for exactly
    // this reason.
    const narrow = coilPitch * coilFill;
    const segLen = coilPitch * 3;
    const nRow = Math.max(3, Math.round(statorSize / segLen) + 1);
    const spanB = (nSide - 1) * coilPitch;
    const spanR = (nRow - 1) * segLen;
    // Alternate columns are STAGGERED by half a segment. Without the stagger,
    // every coil in a column ends at the same y, so the platen periodically
    // straddles a seam where only perpendicular end-turns sit underneath it and
    // lift capability collapses below 1x weight -- a dead band it falls through.
    const stagger = (i) => (i % 2 === 0 ? 0 : segLen / 2);
    for (let i = 0; i < nSide; i++) {
      for (let j = 0; j < nRow; j++) {
        coils.push(mkCoil(-spanB / 2 + i * coilPitch, -spanR / 2 + j * segLen + stagger(i),
          narrow, segLen * coilFill, 0));
      }
    }
    for (let i = 0; i < nSide; i++) {
      for (let j = 0; j < nRow; j++) {
        const c = mkCoil(-spanR / 2 + j * segLen + stagger(i), -spanB / 2 + i * coilPitch,
          segLen * coilFill, narrow, Math.PI / 2);
        c.z = -thickness * 1.6; // the second bank sits in a layer below the first
        coils.push(c);
      }
    }
  } else {
    for (let j = 0; j < nSide; j++) {
      for (let i = 0; i < nSide; i++) {
        coils.push(mkCoil(-span / 2 + i * coilPitch, -span / 2 + j * coilPitch, outer[0], outer[1], 0));
      }
    }
  }

  // Precompute world-space filament positions. The stator never moves, so this
  // is done once and the hot loop just reads it.
  for (const c of coils) {
    const n = c.fil.n;
    const wm = new Float64Array(n * 3);
    const wd = new Float64Array(n * 3);
    for (let s = 0; s < n; s++) {
      wm[s * 3] = c.x + c.fil.mid[s * 3];
      wm[s * 3 + 1] = c.y + c.fil.mid[s * 3 + 1];
      wm[s * 3 + 2] = c.z;
      wd[s * 3] = c.fil.dl[s * 3];
      wd[s * 3 + 1] = c.fil.dl[s * 3 + 1];
      wd[s * 3 + 2] = 0;
    }
    c.wmid = wm;
    c.wdl = wd;
    c.nSeg = n;
    c.radius = Math.hypot(c.outer[0], c.outer[1]) / 2;
  }

  const totalCopper = coils.reduce(
    (a, c) => a + effTurns * 2 * (c.outer[0] + c.outer[1]) * wireArea, 0);

  return {
    cfg, coils, thickness, truncated,
    effTurns, wireArea,
    turnsAreDerived: !isPcbCoil(coilType),
    // The trace the board is really built with, and whether the copper weight
    // forced it wider than the user asked for (so the UI can say so honestly).
    pcbEffTrace,
    pcbTraceLimited: pcbEffTrace !== null && pcbEffTrace > cfg.pcbTraceWidth + 1e-12,
    copperMass: totalCopper * 8960,
    label: COIL_TYPES[coilType].label,
  };
}
