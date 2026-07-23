// Design-space sweeps. These are the questions you actually want answered
// before cutting a PCB or buying 400 magnets:
//   * how far can it fly?            -> liftVsGap
//   * what pole pitch should I use?  -> pitchSweep
//   * are there dead spots?          -> capabilityMap
//   * how much force ripple?         -> rippleScan
//   * how hot does the stator get?   -> hover power, everywhere

import { quat } from './math.js';
import { makeTranslator, fieldAt, peakField, fieldLocal, cellSize } from './halbach.js';
import { makeStator } from './coils.js';
import { buildWrench, analysePose, allocate, copperLoss, capability, singularValues } from './physics.js';
import { arrayField, layTile } from './reference-field.js';

const _B = new Float64Array(3);

/** Cross-check the harmonic air-gap field against an EXACT finite-array model.
 *
 *  src/halbach.js assumes the magnet array is infinite and periodic; that is the
 *  right model for the interior and the source of the "edge error" caveat. This
 *  lays the ACTUAL finite platen out block-by-block and evaluates the exact
 *  Furlani charge-sheet field (reference-field.js -- no shared code, no
 *  periodicity, real edges), then measures where the fast model and the exact one
 *  agree. Interior error is mostly harmonic truncation (small); edge error is the
 *  infinite-array assumption itself, and it grows as the platen shrinks toward a
 *  couple of wavelengths. Returns null-ish {available:false} for layouts the
 *  reference cannot lay out (the four-array cross) or a platen too large to sum in
 *  real time. Not called in the hot loop -- this is a one-shot design check. */
export function fieldCrossCheck(tr, { grid = 11, maxCells = 3000 } = {}) {
  // The reference lays a single continuous array; the quad cross would need four
  // placed, rotated arrays, so scope the check to the single-array layout.
  if (tr.patches.length !== 1) return { available: false, reason: 'layout' };
  const tile = tr.tile;
  const cell = cellSize(tile)[0];
  const th = tr.cfg.magnetThickness;
  const gap = tr.cfg.gap;
  const half = tr.patches[0].w / 2;
  const N = Math.max(1, Math.round(half / cell));
  const cells = layTile(tile, tile.nx, cell, -N, N);
  if (!cells.length) return { available: false, reason: 'empty' };
  if (cells.length > maxCells) return { available: false, reason: 'toobig', nCells: cells.length };

  const zc = -th / 2 - gap;                 // the air-gap plane below the array
  const B = [0, 0, 0];

  // Peak |B| from a FINE scan over the central two cells (where the field crests,
  // away from the edges so both models are in their comfort zone). Both models are
  // scanned the same way so the comparison is apples-to-apples -- note this is the
  // true peak |B|, roughly twice the "Peak gap field" tile, which reports only the
  // fundamental harmonic's amplitude. A coarse platen-wide grid would miss the
  // crest and make the peak a sampling artifact.
  let peakExact = 0, peakHarm = 0;
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      const x = (i / 12 - 0.5) * 2 * cell, y = (j / 12 - 0.5) * 2 * cell;
      const e = arrayField(cells, cell, th, x, y, zc);
      peakExact = Math.max(peakExact, Math.hypot(e[0], e[1], e[2]));
      fieldLocal(tr.harm, x, y, gap, B);
      peakHarm = Math.max(peakHarm, Math.hypot(B[0], B[1], B[2]));
    }
  }
  const norm = peakExact || 1;

  // Agreement across the platen, split into a central CORE (inner half) and the
  // RIM (outer quarter), normalised by the true peak. Fractional bands stay
  // meaningful even on a two-wavelength platen, where "within a pole pitch of an
  // edge" would be the whole thing.
  let cS = 0, cN = 0, rS = 0, rN = 0, mx = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = (i / (grid - 1) - 0.5) * 2 * half;
      const y = (j / (grid - 1) - 0.5) * 2 * half;
      const exact = arrayField(cells, cell, th, x, y, zc);
      fieldLocal(tr.harm, x, y, gap, B);
      const e = Math.hypot(B[0] - exact[0], B[1] - exact[1], B[2] - exact[2]) / norm;
      if (e > mx) mx = e;
      const rr = Math.max(Math.abs(x), Math.abs(y)) / half;
      if (rr <= 0.5) { cS += e * e; cN++; } else if (rr >= 0.75) { rS += e * e; rN++; }
    }
  }
  return {
    available: true,
    peakExact, peakHarm,
    peakErr: Math.abs(peakHarm - peakExact) / norm,
    coreRms: cN ? Math.sqrt(cS / cN) : 0,
    rimRms: rN ? Math.sqrt(rS / rN) : 0,
    maxErr: mx,
    nCells: cells.length,
    wavelengths: (2 * half) / tr.cfg.pitch,
  };
}

/** Field a single coil radiates at an external point p, per ampere of TERMINAL
 *  current (the turns factor is already folded into c.wdl). Straight Biot-Savart
 *  over the coil's own filament segments: B = (mu0/4pi) * sum dl x r / |r|^3.
 *  This is the REVERSE of buildWrench, which evaluates the magnet field at the
 *  coil; here we evaluate the coil's field at the sensor. */
function coilFieldPerA(c, px, py, pz, out) {
  const wm = c.wmid, wd = c.wdl, n = c.nSeg;
  let bx = 0, by = 0, bz = 0;
  for (let s = 0; s < n; s++) {
    const i3 = s * 3;
    const rx = px - wm[i3], ry = py - wm[i3 + 1], rz = pz - wm[i3 + 2];
    const r2 = rx * rx + ry * ry + rz * rz;
    if (r2 < 1e-12) continue;
    const inv = 1 / (r2 * Math.sqrt(r2));       // 1 / |r|^3
    const lx = wd[i3], ly = wd[i3 + 1], lz = wd[i3 + 2]; // lz == 0 for planar coils
    bx += (ly * rz - lz * ry) * inv;
    by += (lz * rx - lx * rz) * inv;
    bz += (lx * ry - ly * rx) * inv;
  }
  const k = 1e-7;                                // mu0 / 4pi
  out[0] = k * bx; out[1] = k * by; out[2] = k * bz;
}

/** Can a bottom-side flux sensor under each coil see the MOVER through the board?
 *
 *  Constraint driving this: no components on the top (magnet) face -- the sensor
 *  must live on the bottom copper and read the Halbach field through the whole
 *  board -- and the air gap is small. Two things then fight the measurement:
 *    1. The board thickness pushes the sensor further from the magnets, so the
 *       mover field is attenuated ~exp(-2pi*thickness/lambda) versus the top face.
 *    2. The coil's OWN current makes a field at its centre that swamps the mover.
 *       BUT by symmetry a planar coil's self-field on its axis is purely Bz: the
 *       in-plane Bx/By at the sensor are ~zero for the coil itself, so they carry
 *       the mover's position signal almost self-field-free. This measures how much
 *       cleaner the in-plane axes are than the vertical one -- i.e. whether a
 *       1-axis (Bz) sensor is fighting the worst axis and a 3-axis part is worth it.
 *
 *  Coil currents are all KNOWN (current-controlled drivers), so the self+neighbour
 *  term is subtractable; the ratios here are the RAW signal-to-coil-field before
 *  that subtraction, per axis, at a representative coil current. Not a hot path. */
export function sensorObservability(stator, tr, { iRef = 7.5, gap = 0.002, maxSensors = 400 } = {}) {
  const coils = stator.coils;
  if (!coils.length) return { available: false };
  const th = stator.thickness;
  const zBot = -th;            // sensor on the bottom copper
  const zTop = 0;              // ideal reference: top face, right under the magnets
  const R = quat.toMat3(quat.identity());
  const r = [0, 0, gap];       // mover centred at hover, magnet face at world z = gap

  // Source culling: coil field dies as 1/r^3, so only near neighbours matter.
  const span = coils.reduce((a, c) => Math.max(a, c.outer[0], c.outer[1]), 0);
  const cull = 3.2 * span;

  // Evaluate a representative set of sensors (stride if the platen is huge).
  const stride = Math.max(1, Math.ceil(coils.length / maxSensors));
  const self = [0, 0, 0], nb = [0, 0, 0], mvBot = [0, 0, 0], mvTop = [0, 0, 0];

  const purities = [], inRatios = [], vertRatios = [], moverBot = [], moverTop = [], fullScale = [];
  let n = 0;
  for (let si = 0; si < coils.length; si += stride) {
    const sc = coils[si];
    const px = sc.x, py = sc.y;
    // Only sensors actually under the mover see a signal worth talking about; the
    // rest of a large stator is dark. Score observability where the platen hovers.
    if (Math.hypot(px, py) > tr.footprintRadius) continue;

    // Own-coil (self) field and the summed-square in-plane / vertical field from
    // every nearby coil at 1 A -- the L2 sensitivity of each axis to a unit-RMS
    // current vector, which is the contamination a real allocation injects.
    coilFieldPerA(sc, px, py, zBot, self);
    let cxy2 = 0, cz2 = 0, ax = 0, ay = 0, az = 0;
    for (let j = 0; j < coils.length; j++) {
      const c = coils[j];
      if (Math.abs(c.x - px) > cull || Math.abs(c.y - py) > cull) continue;
      coilFieldPerA(c, px, py, zBot, nb);
      cxy2 += nb[0] * nb[0] + nb[1] * nb[1];   // RSS: typical field from independent currents
      cz2 += nb[2] * nb[2];
      ax += Math.abs(nb[0]); ay += Math.abs(nb[1]); az += Math.abs(nb[2]); // worst case: all aligned
    }
    const coilInPlane = Math.sqrt(cxy2), coilVert = Math.sqrt(cz2);
    fullScale.push(Math.hypot(ax, ay, az) * iRef);   // saturation ceiling the sensor must clear

    fieldAt(tr, px, py, zBot, r, R, mvBot);
    fieldAt(tr, px, py, zTop, r, R, mvTop);
    const mInPlane = Math.hypot(mvBot[0], mvBot[1]);
    const mVert = Math.abs(mvBot[2]);
    const mMagBot = Math.hypot(mvBot[0], mvBot[1], mvBot[2]);
    const mMagTop = Math.hypot(mvTop[0], mvTop[1], mvTop[2]);

    const selfMag = Math.hypot(self[0], self[1], self[2]) || 1;
    purities.push(Math.hypot(self[0], self[1]) / selfMag);   // in-plane share of self-field
    if (coilInPlane > 0) inRatios.push(mInPlane / (coilInPlane * iRef));
    if (coilVert > 0) vertRatios.push(mVert / (coilVert * iRef));
    moverBot.push(mMagBot);
    moverTop.push(mMagTop);
    n++;
  }
  if (!n) return { available: false };

  const med = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const ratioIn = med(inRatios), ratioVert = med(vertRatios);
  // How accurately must the coil-field model C be calibrated? Raw SNR per axis is
  // (mover signal / coil field) = ratio. Subtracting the modelled C*i with fractional
  // error eps leaves residual eps*coilField, so post-subtraction SNR = ratio/eps. To
  // reach SNR_target the calibration must satisfy eps <= ratio/SNR_target. The
  // in-plane axes start clean (large ratio -> loose tolerance); Bz is the binding one.
  const SNR_TARGET = 10;
  return {
    available: true,
    nSensors: n,
    boardMM: th * 1000,
    moverBot: med(moverBot),
    moverTop: med(moverTop),
    boardLoss: med(moverTop) > 0 ? 1 - med(moverBot) / med(moverTop) : 0,
    selfInPlaneShare: med(purities),   // ~0 confirms the self-field is on Bz only
    ratioIn, ratioVert,
    cleanFactor: ratioVert > 0 ? ratioIn / ratioVert : 0,
    fullScale: Math.max(...fullScale),          // T, worst-case field any sensor sees
    snrTarget: SNR_TARGET,
    calIn: Math.min(1, ratioIn / SNR_TARGET),   // required coil-field-model accuracy, in-plane
    calVert: Math.min(1, ratioVert / SNR_TARGET), // ... and on Bz (the binding one)
    iRef,
  };
}

/** Air-gap field on a horizontal plane, in the translator's own frame.
 *  component: 'bz' | 'mag'. */
export function fieldMap(tr, gap, half, n, component = 'bz') {
  const data = new Float64Array(n * n);
  const r = [0, 0, gap];
  const R = quat.toMat3(quat.identity());
  for (let j = 0; j < n; j++) {
    const y = -half + (2 * half * (j + 0.5)) / n;
    for (let i = 0; i < n; i++) {
      const x = -half + (2 * half * (i + 0.5)) / n;
      fieldAt(tr, x, y, 0, r, R, _B);
      data[j * n + i] = component === 'mag' ? Math.hypot(_B[0], _B[1], _B[2]) : _B[2];
    }
  }
  return { data, nx: n, ny: n, extent: [-half, half, -half, half] };
}

/** Lift capacity and hover power as the air gap opens up. This is the single
 *  most decision-relevant plot in the app: the exp(-k*gap) wall is why pole
 *  pitch and achievable gap are the same design variable. */
export function liftVsGap(stator, tr, iMax, gaps) {
  const q = quat.identity();
  const weight = tr.mass * 9.80665;
  const out = { lift: [], margin: [], power: [], field: [] };
  for (const g of gaps) {
    const Wm = buildWrench(stator, tr, [0, 0, g], q);
    const cap = capability(Wm, [0, 0, 1, 0, 0, 0], iMax);
    const hover = allocate(Wm, [0, 0, weight, 0, 0, 0], { iMax });
    out.lift.push([g * 1000, cap.magnitude]);
    out.margin.push([g * 1000, cap.magnitude / weight]);
    out.power.push([g * 1000, hover.saturated > 1e-6 ? NaN : copperLoss(stator, Wm, hover.i)]);
    out.field.push([g * 1000, peakField(tr.harm, g)]);
  }
  return out;
}

/** Rebuild the whole machine at each pole pitch. Expensive but it is the
 *  question everyone asks first, and the answer is not monotonic: bigger pitch
 *  reaches further but puts less field per magnet at a small gap. */
export function pitchSweep(cfg, pitches, iMax) {
  const rows = [];
  const OFFSETS = [[0, 0], [0.25, 0.15], [0.5, 0.35], [0.75, 0.6]];
  for (const pitch of pitches) {
    const tr = makeTranslator({ ...cfg.translator, pitch, gap: cfg.sim.gap });
    // Coil pitch tracks pole pitch at the three-phase ratio. Using lambda/2
    // here would put every point of the sweep on the degenerate ratio where
    // lateral force cancels, and the curve comes out as noise.
    const coilPitch = cfg.stator.lockCoilPitch ? cfg.stator.coilPitch : pitch / 3;
    const stator = makeStator({ ...cfg.stator, coilPitch });

    // Sample several sub-pitch offsets and keep the WORST. A single centred
    // evaluation lands on a symmetry point and flatters (or slanders) the
    // design depending on how the coil grid happens to line up.
    let worst = null, powSum = 0, powN = 0;
    for (const [ox, oy] of OFFSETS) {
      const r = [ox * coilPitch, oy * coilPitch, cfg.sim.gap];
      const a = analysePose(stator, tr, r, quat.identity(), iMax);
      if (isFinite(a.hoverPower) && a.hoverSaturated <= 1e-6) { powSum += a.hoverPower; powN++; }
      if (!worst || a.liftMargin < worst.liftMargin) worst = a;
    }
    rows.push({
      pitch: pitch * 1000,
      margin: worst.liftMargin,
      accel: worst.maxAccel / 9.80665,
      power: powN ? powSum / powN : NaN,
      sigmaMin: worst.sigmaMin,
      cond: worst.conditionNumber,
      mass: tr.mass,
      coils: worst.activeCoils,
      peakB: tr.peakGapField,
    });
  }
  return rows;
}

/** Sweep the platen across the stator and report a scalar at each position.
 *  metric: 'lift' | 'sigmaMin' | 'power' | 'cond' */
export function capabilityMap(stator, tr, gap, half, n, iMax, metric = 'lift') {
  const q = quat.identity();
  const data = new Float64Array(n * n);
  const weight = tr.mass * 9.80665;
  const charLength = tr.cfg.platenSize / 2;
  for (let j = 0; j < n; j++) {
    const y = -half + (2 * half * (j + 0.5)) / n;
    for (let i = 0; i < n; i++) {
      const x = -half + (2 * half * (i + 0.5)) / n;
      const Wm = buildWrench(stator, tr, [x, y, gap], q);
      let v = 0;
      if (metric === 'lift') {
        v = capability(Wm, [0, 0, 1, 0, 0, 0], iMax).magnitude / weight;
      } else if (metric === 'power') {
        const hv = allocate(Wm, [0, 0, weight, 0, 0, 0], { iMax });
        v = hv.saturated > 1e-6 ? NaN : copperLoss(stator, Wm, hv.i);
      } else {
        const sv = singularValues(Wm, charLength);
        v = metric === 'cond' ? (sv[5] > 1e-12 ? sv[0] / sv[5] : NaN) : sv[5];
      }
      data[j * n + i] = v;
    }
  }
  return { data, nx: n, ny: n, extent: [-half, half, -half, half] };
}

/** Force ripple: hold the commanded wrench at pure hover and scan the platen
 *  along x. A perfectly commutated machine shows a flat peak current and zero
 *  parasitic force; real ones ripple at the coil pitch. */
export function rippleScan(stator, tr, gap, span, n, iMax) {
  const q = quat.identity();
  const weight = tr.mass * 9.80665;
  const cmd = [0, 0, weight, 0, 0, 0];
  const out = { peakI: [], power: [], fxErr: [], txErr: [], sigmaMin: [] };
  const charLength = tr.cfg.platenSize / 2;
  for (let i = 0; i < n; i++) {
    const x = -span / 2 + (span * i) / (n - 1);
    const Wm = buildWrench(stator, tr, [x, 0, gap], q);
    const a = allocate(Wm, cmd, { iMax });
    let peak = 0;
    for (let j = 0; j < a.i.length; j++) peak = Math.max(peak, Math.abs(a.i[j]));
    out.peakI.push([x * 1000, peak]);
    out.power.push([x * 1000, copperLoss(stator, Wm, a.i)]);
    // Residual off-axis wrench after least-norm allocation: pure numerical
    // conditioning error if the design is healthy, real cross-coupling if not.
    out.fxErr.push([x * 1000, a.achieved[0]]);
    out.txErr.push([x * 1000, a.achieved[3]]);
    out.sigmaMin.push([x * 1000, singularValues(Wm, charLength)[5]]);
  }
  return out;
}

/** Steady-state stator temperature rise. Kept as a thin wrapper for callers
 *  that only have an area; anything with a real build should go through
 *  mechanical.js stackUp(), which knows the spreader and the cooling class. */
export function thermal(power, statorArea, h = 12) {
  return power / Math.max(h * statorArea * 2, 1e-9);
}
