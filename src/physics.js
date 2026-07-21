// The heart of the simulator.
//
// Force and torque on the platen are LINEAR in the coil currents, so the whole
// electromechanical coupling collapses to a single 6xN "wrench matrix" W:
//
//     [Fx Fy Fz Tx Ty Tz]^T  =  W(pose) . i
//
// Column j of W is the wrench produced by one ampere in coil j, computed by
// Lorentz integration of I dl x B over that coil's filaments (B from the magnet
// array) and then negated -- the coil feels I dl x B, the platen feels the
// reaction.
//
// Everything else follows from W:
//   * commutation      -> i = W^+ w_desired   (damped least-norm)
//   * force capability -> singular values of W
//   * dead spots       -> poses where sigma_min(W) collapses
//   * hover power      -> sum(i^2 R)

import { quat, solveSPD, symEigenvalues } from './math.js';
import { fieldAt } from './halbach.js';
import { buildGrouping } from './grouping.js';

const _B = new Float64Array(3);

/** Coils close enough to the platen to matter. Far coils contribute a field
 *  attenuated by exp(-k*d) in the gap AND by the footprint taper, so culling is
 *  essentially lossless -- but it is what makes the sim real-time. */
export function activeCoils(stator, tr, r, margin = 0) {
  const reach = tr.footprintRadius + margin;
  const out = [];
  for (let i = 0; i < stator.coils.length; i++) {
    const c = stator.coils[i];
    const dx = c.x - r[0], dy = c.y - r[1];
    if (Math.abs(dx) < reach + c.outer[0] / 2 && Math.abs(dy) < reach + c.outer[1] / 2) {
      out.push(i);
    }
  }
  return out;
}

/** Build W for the given pose. Returns {W (Float64Array 6*n, column-major by
 *  coil: W[6*j + row]), idx (coil indices)}. */
export function buildWrench(stator, tr, r, q, opts = {}) {
  const R = quat.toMat3(q);
  const idx = activeCoils(stator, tr, r, opts.margin ?? 0);
  const n = idx.length;
  const W = new Float64Array(6 * n);

  for (let j = 0; j < n; j++) {
    const c = stator.coils[idx[j]];
    let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
    const nSeg = c.nSeg, wm = c.wmid, wd = c.wdl;
    for (let s = 0; s < nSeg; s++) {
      const i3 = s * 3;
      const mx = wm[i3], my = wm[i3 + 1], mz = wm[i3 + 2];
      fieldAt(tr, mx, my, mz, r, R, _B);
      const bx = _B[0], by = _B[1], bz = _B[2];
      if (bx === 0 && by === 0 && bz === 0) continue;
      const lx = wd[i3], ly = wd[i3 + 1], lz = wd[i3 + 2];
      // dF = dl x B  (per ampere), force on the COIL
      const dfx = ly * bz - lz * by;
      const dfy = lz * bx - lx * bz;
      const dfz = lx * by - ly * bx;
      fx += dfx; fy += dfy; fz += dfz;
      // Torque on the coil about the platen's centre of mass.
      const ax = mx - r[0], ay = my - r[1], az = mz - r[2];
      tx += ay * dfz - az * dfy;
      ty += az * dfx - ax * dfz;
      tz += ax * dfy - ay * dfx;
    }
    // Newton's third law: the platen gets the negative of all of it.
    const o = j * 6;
    W[o] = -fx; W[o + 1] = -fy; W[o + 2] = -fz;
    W[o + 3] = -tx; W[o + 4] = -ty; W[o + 5] = -tz;
  }
  return { W, idx, n };
}

/** Compose a grouping onto a wrench matrix: W_eff = W G.
 *  The result is the same shape of object, so allocate(), singularValues(),
 *  capability() and the dead-spot maps all work on it without knowing that
 *  grouping happened. `n` becomes the AMPLIFIER count, not the coil count. */
export function groupWrench(Wm, grouping) {
  if (!grouping || grouping.identity) return Wm;
  const { G, nCoils, nPhases } = grouping;
  const W = new Float64Array(6 * nPhases);
  for (let p = 0; p < nPhases; p++) {
    const gOff = p * nCoils, wOff = p * 6;
    for (let j = 0; j < nCoils; j++) {
      const gj = G[gOff + j];
      if (gj === 0) continue;
      const o = j * 6;
      for (let a = 0; a < 6; a++) W[wOff + a] += Wm.W[o + a] * gj;
    }
  }
  return { W, idx: Wm.idx, n: nPhases, grouping, base: Wm };
}

/** Per-coil currents implied by a phase-current vector. Needed because the
 *  current limit and the copper loss are properties of COILS, not amplifiers. */
export function coilCurrents(Wm, u) {
  if (!Wm.grouping) return u;
  const { G, nCoils, nPhases } = Wm.grouping;
  const i = new Float64Array(nCoils);
  for (let p = 0; p < nPhases; p++) {
    const up = u[p];
    if (up === 0) continue;
    const gOff = p * nCoils;
    for (let j = 0; j < nCoils; j++) i[j] += G[gOff + j] * up;
  }
  return i;
}

/** Gram matrix G = W W^T (6x6, row-major). */
function gram(W, n) {
  const G = new Float64Array(36);
  for (let j = 0; j < n; j++) {
    const o = j * 6;
    for (let a = 0; a < 6; a++) {
      const wa = W[o + a];
      if (wa === 0) continue;
      for (let b = a; b < 6; b++) G[a * 6 + b] += wa * W[o + b];
    }
  }
  for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) G[a * 6 + b] = G[b * 6 + a];
  return G;
}

/** Minimum-norm current allocation: i = W^T (W W^T + lambda I)^-1 w.
 *  Damping keeps it well-behaved when the platen wanders into a pose where
 *  some wrench direction is nearly unreachable -- without it, the allocator
 *  demands unbounded current instead of just failing gracefully. */
export function allocate(Wm, w, { damping = 1e-9, iMax = Infinity } = {}) {
  const { W, n } = Wm;
  if (n === 0) return { i: new Float64Array(0), saturated: 0, achieved: [0, 0, 0, 0, 0, 0] };
  const G = gram(W, n);
  // Scale damping to the matrix so it means the same thing across designs.
  let tr = 0;
  for (let a = 0; a < 6; a++) tr += G[a * 6 + a];
  const lam = damping * (tr / 6 + 1e-30);
  for (let a = 0; a < 6; a++) G[a * 6 + a] += lam;

  const y = solveSPD(G, w, 6);
  const cur = new Float64Array(n);
  if (!y) return { i: cur, saturated: 1, achieved: [0, 0, 0, 0, 0, 0], singular: true };

  let peak = 0;
  for (let j = 0; j < n; j++) {
    const o = j * 6;
    let v = 0;
    for (let a = 0; a < 6; a++) v += W[o + a] * y[a];
    cur[j] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // The current limit binds on COILS. Under a grouping, one amplifier feeds
  // many coils with different weights, so the amplifier current says nothing
  // directly about whether any coil is over its limit -- recover the coil
  // currents and limit on those.
  let coilI = coilCurrents(Wm, cur);
  if (Wm.grouping) {
    peak = 0;
    for (let j = 0; j < coilI.length; j++) peak = Math.max(peak, Math.abs(coilI[j]));
  }
  // Uniform scale-back preserves the wrench DIRECTION when we cannot reach its
  // magnitude, which is far better behaved in a control loop than per-coil
  // clipping (that would distort the wrench and cross-couple the axes).
  let scale = 1;
  if (peak > iMax) {
    scale = iMax / peak;
    for (let j = 0; j < n; j++) cur[j] *= scale;
    coilI = coilCurrents(Wm, cur);
  }
  const achieved = wrenchOf(Wm, cur);
  return { i: cur, coilI, saturated: 1 - scale, achieved, peak: peak * scale };
}

/** Two-priority allocation. Levitation is not negotiable: if the commanded
 *  wrench needs more current than the drivers can supply, scaling the WHOLE
 *  wrench back (what plain allocate() does) throttles lift along with
 *  everything else and the platen simply falls out of the sky. This solves the
 *  primary wrench first, then admits as much of the secondary as the remaining
 *  headroom allows -- exactly the priority a real stage controller uses. */
export function allocatePrioritised(Wm, primary, secondary, iMax) {
  const a = allocate(Wm, primary, { iMax });
  if (a.saturated > 1e-9 || Wm.n === 0) return { ...a, secondaryScale: 0 };
  const b = allocate(Wm, secondary, { iMax: Infinity });

  // Largest s in [0,1] with |a_j + s*b_j| <= iMax for every COIL. Under a
  // grouping the headroom test lives in coil space, not amplifier space.
  const aC = a.coilI ?? a.i, bC = b.coilI ?? b.i;
  let s = 1;
  for (let j = 0; j < aC.length; j++) {
    const bj = bC[j];
    if (Math.abs(bj) < 1e-15) continue;
    const room = bj > 0 ? iMax - aC[j] : -iMax - aC[j];
    const sj = room / bj;
    if (sj < s) s = Math.max(sj, 0);
  }
  const cur = new Float64Array(Wm.n);
  for (let j = 0; j < Wm.n; j++) cur[j] = a.i[j] + s * b.i[j];
  const coilI = coilCurrents(Wm, cur);
  let peak = 0;
  for (let j = 0; j < coilI.length; j++) peak = Math.max(peak, Math.abs(coilI[j]));
  return {
    i: cur, coilI, peak, saturated: 1 - s, secondaryScale: s,
    achieved: wrenchOf(Wm, cur),
  };
}

export function wrenchOf(Wm, cur) {
  const { W, n } = Wm;
  const w = [0, 0, 0, 0, 0, 0];
  for (let j = 0; j < n; j++) {
    const o = j * 6, c = cur[j];
    if (c === 0) continue;
    for (let a = 0; a < 6; a++) w[a] += W[o + a] * c;
  }
  return w;
}

export function copperLoss(stator, Wm, cur) {
  const i = Wm.grouping ? coilCurrents(Wm, cur) : cur;
  let p = 0;
  for (let j = 0; j < Wm.idx.length; j++) p += i[j] * i[j] * stator.coils[Wm.idx[j]].R;
  return p;
}

// --- design metrics ---------------------------------------------------------

/** Singular values of W with the torque rows normalised by a characteristic
 *  length, so force and torque are commensurate and the condition number
 *  actually means something. Without that normalisation the number just
 *  reports your choice of units. */
export function singularValues(Wm, charLength) {
  const { W, n } = Wm;
  if (n === 0) return [0, 0, 0, 0, 0, 0];
  const Wn = new Float64Array(W.length);
  for (let j = 0; j < n; j++) {
    const o = j * 6;
    Wn[o] = W[o]; Wn[o + 1] = W[o + 1]; Wn[o + 2] = W[o + 2];
    Wn[o + 3] = W[o + 3] / charLength;
    Wn[o + 4] = W[o + 4] / charLength;
    Wn[o + 5] = W[o + 5] / charLength;
  }
  const G = gram(Wn, n);
  return symEigenvalues(G, 6).map((e) => Math.sqrt(Math.max(e, 0)));
}

/** Peak achievable force along `dir` (a 6-vector direction) with every coil
 *  held inside iMax, while all other wrench components stay zero.
 *  Solves for the unit wrench, then scales until the hottest coil hits iMax. */
export function capability(Wm, dir, iMax) {
  const res = allocate(Wm, dir, { iMax: Infinity });
  if (!res.i.length) return { magnitude: 0, currents: res.i };
  // Scale until the hottest COIL hits the limit, not the hottest amplifier.
  const lim = res.coilI ?? res.i;
  let peak = 0;
  for (let j = 0; j < lim.length; j++) peak = Math.max(peak, Math.abs(lim[j]));
  if (peak < 1e-12) return { magnitude: 0, currents: res.i };
  const scale = iMax / peak;
  return { magnitude: scale, currents: res.i.map((v) => v * scale) };
}

/** Full static report at one pose -- this is what the Design tab shows. */
export function analysePose(stator, tr, r, q, iMax, groupMode = 'independent') {
  const base = buildWrench(stator, tr, r, q);
  const Wm = groupMode === 'independent' ? base
    : groupWrench(base, buildGrouping(stator, tr, r, q, groupMode, base.idx));
  const g = 9.80665;
  const weight = tr.mass * g;
  const charLength = tr.cfg.platenSize / 2;

  const lift = capability(Wm, [0, 0, 1, 0, 0, 0], iMax);
  const thrust = capability(Wm, [1, 0, 0, 0, 0, 0], iMax);
  const tilt = capability(Wm, [0, 0, 0, 1, 0, 0], iMax);
  const yaw = capability(Wm, [0, 0, 0, 0, 0, 1], iMax);

  const hover = allocate(Wm, [0, 0, weight, 0, 0, 0], { iMax });
  const sv = singularValues(Wm, charLength);

  return {
    Wm,
    activeCoils: base.idx.length,
    amplifiers: Wm.n,
    weight,
    liftCapacity: lift.magnitude,
    liftMargin: lift.magnitude / weight,
    thrustCapacity: thrust.magnitude,
    maxAccel: thrust.magnitude / tr.mass,
    tiltCapacity: tilt.magnitude,
    yawCapacity: yaw.magnitude,
    hoverCurrents: hover.i,
    hoverPeakCurrent: hover.peak ?? 0,
    hoverPower: copperLoss(stator, Wm, hover.i),
    hoverSaturated: hover.saturated,
    sigma: sv,
    conditionNumber: sv[5] > 1e-12 ? sv[0] / sv[5] : Infinity,
    sigmaMin: sv[5],
  };
}

// --- rigid-body dynamics ----------------------------------------------------

export function makeState(tr, gap) {
  return {
    r: [0, 0, gap],
    v: [0, 0, 0],
    q: quat.identity(),
    w: [0, 0, 0],
    t: 0,
    landed: false,
  };
}

const G_ACCEL = 9.80665;

/** Semi-implicit Euler with world-frame angular velocity. The platen is a rigid
 *  body with a diagonal inertia in its own frame, so the gyroscopic term is
 *  evaluated in the body frame and rotated back. */
export function step(state, tr, wrench, dt, opts = {}) {
  const { r, v, q, w } = state;
  const m = tr.mass;
  const I = tr.inertia;

  const ax = wrench[0] / m;
  const ay = wrench[1] / m;
  const az = wrench[2] / m - G_ACCEL;

  v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt;
  r[0] += v[0] * dt; r[1] += v[1] * dt; r[2] += v[2] * dt;

  // Angular: convert torque and omega to body frame, integrate Euler's
  // equations, convert back.
  const R = quat.toMat3(q);
  const tb = [
    R[0] * wrench[3] + R[3] * wrench[4] + R[6] * wrench[5],
    R[1] * wrench[3] + R[4] * wrench[4] + R[7] * wrench[5],
    R[2] * wrench[3] + R[5] * wrench[4] + R[8] * wrench[5],
  ];
  const wb = [
    R[0] * w[0] + R[3] * w[1] + R[6] * w[2],
    R[1] * w[0] + R[4] * w[1] + R[7] * w[2],
    R[2] * w[0] + R[5] * w[1] + R[8] * w[2],
  ];
  const dwb = [
    (tb[0] - (I[2] - I[1]) * wb[1] * wb[2]) / I[0],
    (tb[1] - (I[0] - I[2]) * wb[2] * wb[0]) / I[1],
    (tb[2] - (I[1] - I[0]) * wb[0] * wb[1]) / I[2],
  ];
  wb[0] += dwb[0] * dt; wb[1] += dwb[1] * dt; wb[2] += dwb[2] * dt;
  w[0] = R[0] * wb[0] + R[1] * wb[1] + R[2] * wb[2];
  w[1] = R[3] * wb[0] + R[4] * wb[1] + R[5] * wb[2];
  w[2] = R[6] * wb[0] + R[7] * wb[1] + R[8] * wb[2];

  state.q = quat.integrate(q, w, dt);
  state.t += dt;

  // Crash floor: the platen physically cannot pass through the stator.
  const floor = (opts.floorZ ?? 0) + 0.0002;
  if (r[2] < floor) {
    r[2] = floor;
    if (v[2] < 0) v[2] = 0;
    state.landed = true;
  } else if (r[2] > floor + 0.0005) {
    state.landed = false;
  }
  return state;
}
