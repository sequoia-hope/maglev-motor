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
export function pcbTurnsPerLayer(w, eff) {
  return Math.max(1, Math.floor((w * (0.5 - PCB_INNER_FRAC)) / (eff * 2)));
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
};

/** Build the stator.
 *  All coils lie in a plane at z = 0; the translator flies above them. */
export function makeStator(cfg) {
  const {
    coilType, coilPitch, coilFill, statorSize,
    windingHeight, wireDiameter, pcbLayers, pcbTraceWidth, pcbCopperThickness,
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

  if (coilType === 'pcb') {
    // A spiral on an N-layer board. Turns per layer is set by how many
    // concentric traces fit in half the coil width -- but at the effective trace
    // width, which the copper weight can force wider than requested (Bugeja's
    // fab rule). Piling on copper thus does NOT monotonically buy turns.
    const w = coilPitch * coilFill;
    const eff = effectiveTrace(pcbTraceWidth, pcbCopperThickness);
    pcbEffTrace = eff;
    const perLayer = pcbTurnsPerLayer(w, eff);
    effTurns = perLayer * pcbLayers;
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
    thickness = pcbLayers * pcbCopperThickness
      + (pcbLayers - 1) * PCB_DIELECTRIC + 2 * PCB_MASK;
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
      x: cx, y: cy, z: -thickness / 2, angle: ang,
      outer: o, inner: i, turns: effTurns,
      R: windingResistance(o, i, effTurns, wireArea),
      fil,
      current: 0,
    };
  };

  if (coilType === 'racetrack') {
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
    turnsAreDerived: coilType !== 'pcb',
    // The trace the board is really built with, and whether the copper weight
    // forced it wider than the user asked for (so the UI can say so honestly).
    pcbEffTrace,
    pcbTraceLimited: pcbEffTrace !== null && pcbEffTrace > cfg.pcbTraceWidth + 1e-12,
    copperMass: totalCopper * 8960,
    label: COIL_TYPES[coilType].label,
  };
}
