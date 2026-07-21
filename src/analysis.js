// Design-space sweeps. These are the questions you actually want answered
// before cutting a PCB or buying 400 magnets:
//   * how far can it fly?            -> liftVsGap
//   * what pole pitch should I use?  -> pitchSweep
//   * are there dead spots?          -> capabilityMap
//   * how much force ripple?         -> rippleScan
//   * how hot does the stator get?   -> hover power, everywhere

import { quat } from './math.js';
import { makeTranslator, fieldAt, peakField } from './halbach.js';
import { makeStator } from './coils.js';
import { buildWrench, analysePose, allocate, copperLoss, capability, singularValues } from './physics.js';

const _B = new Float64Array(3);

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

/** Thermal sanity: steady-state copper temperature rise for a natural-
 *  convection stator. Crude (h is a guess) but it catches the designs that are
 *  obviously going to melt. */
export function thermal(power, statorArea, h = 12) {
  return power / Math.max(h * statorArea * 2, 1e-9);
}
