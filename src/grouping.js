// Phase grouping: driving many coils from few amplifiers.
//
// A real planar motor does NOT give every coil its own current source. Coils are
// wired (or switched) into a small number of phase groups, and the drive
// commutates those groups against the magnet phase. Zhu/Teo/Pang run roughly 60
// coils from EIGHT amplifiers this way.
//
// Model: coil currents are a linear map of phase currents,
//
//     i = G u        G is (nCoils x nPhases)
//
// so the wrench matrix simply composes:
//
//     w = W i = (W G) u
//
// Everything downstream -- allocation, singular values, dead-spot maps -- works
// on W_eff = W G without modification. Grouping costs controllability (W_eff has
// at most rank 6, and usually less than W) and buys amplifiers.
//
// The groups here are the physically realisable kind: SINUSOIDAL COMMUTATION
// weights over a spatial region, referenced to the magnet phase, following the
// platen. That is what a switching matrix in an unlimited-stroke machine does.
// Weights are continuous in position, so W_eff does not jump as the platen
// moves -- a hard-switched grouping would make the plant discontinuous.
//
// LIMITATION: each coil's commutation weight is sampled at its CENTRE. That is
// accurate for compact coils (square, PCB spiral) but poor for long racetracks,
// whose two long sides span a wide range of magnet phase and therefore do not
// commutate cleanly against a single scalar weight. Grouping a racetrack stator
// here costs noticeably more capability than grouping a square-coil one, and
// some of that is this approximation rather than the topology.

import { quat } from './math.js';

export const GROUPINGS = {
  independent: {
    label: 'Independent (one driver per coil)',
    regions: 0,
    note: 'Every coil gets its own current source. Maximum controllability, maximum electronics. This is the upper bound, not what anyone builds.',
  },
  r1: {
    label: 'One group per magnet array',
    regions: 1,
    note: 'Each Halbach array is commutated as one unit. On the four-array cross layout this is exactly the published eight-phase scheme (4 arrays x quadrature). On a single continuous array it gives only 4 phases, which cannot produce independent torques — watch the wrench matrix lose rank.',
  },
  r2: {
    label: '2x2 regions per array',
    regions: 2,
    note: 'Each array is split into quadrants and each quadrant commutated separately. Differential lift between regions gives tilt, differential thrust gives yaw. The usual sweet spot.',
  },
  r3: {
    label: '3x3 regions per array',
    regions: 3,
    note: 'Finer subdivision. More amplifiers, better conditioning and more headroom against local saturation — but the problem is only rank 6, so returns fall off fast.',
  },
};

/** Number of commutation basis functions a tile needs.
 *  A 1-D array has one dominant harmonic, so a quadrature pair (cos, sin)
 *  spans its lift/thrust plane. A 2-D checkerboard has two dominant harmonics
 *  -- (k,k) and (k,-k) -- so it needs a quadrature pair for each. */
function basisCount(tile) {
  return tile.ny === 1 ? 2 : 4;
}

/** Smooth 1-D partition of unity over g cells spanning [-half, half].
 *  Overlapping triangular windows: neighbouring regions blend instead of
 *  switching, which keeps W_eff continuous as the platen moves. */
function regionWeights(x, half, g, out) {
  if (g === 1) { out[0] = 1; return; }
  const t = ((x + half) / (2 * half)) * (g - 1); // 0 .. g-1
  for (let i = 0; i < g; i++) out[i] = Math.max(0, 1 - Math.abs(t - i));
  let s = 0;
  for (let i = 0; i < g; i++) s += out[i];
  if (s > 1e-9) for (let i = 0; i < g; i++) out[i] /= s;
}

/** Build the grouping matrix for the active coil set at this pose.
 *  Returns { G: Float64Array(nCoils * nPhases), nCoils, nPhases }.
 *  G is stored phase-major: G[p * nCoils + j]. */
export function buildGrouping(stator, tr, r, q, mode, idx) {
  const spec = GROUPINGS[mode] ?? GROUPINGS.independent;
  const nCoils = idx.length;

  if (spec.regions === 0) {
    // Identity: each coil is its own phase.
    const G = new Float64Array(nCoils * nCoils);
    for (let j = 0; j < nCoils; j++) G[j * nCoils + j] = 1;
    return { G, nCoils, nPhases: nCoils, mode, identity: true };
  }

  const R = quat.toMat3(q);
  const g = spec.regions;
  const nb = basisCount(tr.tile);
  const nPatch = tr.patches.length;
  // A group is (array, sub-region within that array, commutation basis).
  // Regions must subdivide the ARRAY, not the platen: on the four-array cross
  // the arrays sit in a plus shape, so a platen-wide quadrant grid slices each
  // array in half and the commutation fights itself (condition number ~500).
  const nPhases = nPatch * g * g * nb;
  const G = new Float64Array(nCoils * nPhases);
  const wu = new Float64Array(g), wv = new Float64Array(g);
  const basis = new Float64Array(nb); // hoisted: this runs at the control rate

  const kx = (2 * Math.PI) / tr.tile.lx;
  const ky = (2 * Math.PI) / tr.tile.ly;

  for (let j = 0; j < nCoils; j++) {
    const c = stator.coils[idx[j]];
    // Coil centre in platen frame.
    const ex = c.x - r[0], ey = c.y - r[1], ez = c.z - r[2];
    const bx = R[0] * ex + R[3] * ey + R[6] * ez;
    const by = R[1] * ex + R[4] * ey + R[7] * ez;

    // Which array is this coil under, and where within it?
    let pu = 0, pv = 0, pIdx = -1, pw = 0, ph = 0;
    for (let pi = 0; pi < nPatch; pi++) {
      const pt = tr.patches[pi];
      const dx = bx - pt.u, dy = by - pt.v;
      const qx = dx * pt.cos + dy * pt.sin;
      const qy = -dx * pt.sin + dy * pt.cos;
      if (Math.abs(qx) > pt.w / 2 || Math.abs(qy) > pt.h / 2) continue;
      pu = qx; pv = qy; pIdx = pi; pw = pt.w; ph = pt.h;
      break;
    }
    if (pIdx < 0) continue; // not under any array: leave it unpowered

    regionWeights(pu, pw / 2, g, wu);
    regionWeights(pv, ph / 2, g, wv);

    // Commutation basis, referenced to the magnet phase.
    if (nb === 2) {
      basis[0] = Math.cos(kx * pu);
      basis[1] = Math.sin(kx * pu);
    } else {
      const t1 = kx * pu + ky * pv;
      const t2 = kx * pu - ky * pv;
      basis[0] = Math.cos(t1); basis[1] = Math.sin(t1);
      basis[2] = Math.cos(t2); basis[3] = Math.sin(t2);
    }

    for (let ri = 0; ri < g; ri++) {
      if (wu[ri] < 1e-6) continue;
      for (let rj = 0; rj < g; rj++) {
        if (wv[rj] < 1e-6) continue;
        const rw = wu[ri] * wv[rj];
        const base = ((pIdx * g + ri) * g + rj) * nb;
        for (let b = 0; b < nb; b++) {
          G[(base + b) * nCoils + j] = rw * basis[b];
        }
      }
    }
  }
  return { G, nCoils, nPhases, mode, identity: false };
}
