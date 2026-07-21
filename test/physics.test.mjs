import { ARRAY_TYPES, decompose, peakField, makeTranslator, selfTest, fieldAt } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { buildWrench, analysePose, allocate, capability, singularValues, wrenchOf } from '../src/physics.js';
import { quat } from '../src/math.js';
import { buildGrouping, GROUPINGS } from '../src/grouping.js';
import { groupWrench, coilCurrents } from '../src/physics.js';
import { makeTranslator as mkTr } from '../src/halbach.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!cond) fails++;
};

// 1. Closed-form Halbach fundamental
for (const M of [2, 3, 4, 6, 8]) {
  const t = selfTest({ segments: M });
  check(`selfTest M=${M}`, t.pass, `model ${t.model.toFixed(4)} T vs ${t.analytic.toFixed(4)} T (${(t.relError * 100).toFixed(2)}%)`);
}

// 2. One-sidedness: reversing the in-plane magnets must kill the field below.
{
  const tile = ARRAY_TYPES.halbach1d.build({ pitch: 0.024, thickness: 0.006, Br: 1.32, segments: 8 });
  const flipped = { ...tile, cells: Float64Array.from(tile.cells) };
  for (let i = 0; i < flipped.cells.length; i += 3) flipped.cells[i] *= -1;
  const a = peakField(decompose(tile, { maxOrder: 5, gapRef: 0, tol: 1e-9 }), 0.002);
  const b = peakField(decompose(flipped, { maxOrder: 5, gapRef: 0, tol: 1e-9 }), 0.002);
  check('one-sided flux (wrong handedness is suppressed)', b < a * 0.02, `strong ${a.toFixed(4)} T, weak ${b.toExponential(2)} T`);
}

// 3. Halbach beats plain alternating
{
  const p = { pitch: 0.024, thickness: 0.006, Br: 1.32, segments: 4 };
  const hb = peakField(decompose(ARRAY_TYPES.halbach1d.build(p), { maxOrder: 5, gapRef: 0.002 }), 0.002);
  const alt = peakField(decompose(ARRAY_TYPES.alternating.build(p), { maxOrder: 5, gapRef: 0.002 }), 0.002);
  check('Halbach > plain N/S at the gap', hb > alt * 1.2, `${hb.toFixed(4)} T vs ${alt.toFixed(4)} T (ratio ${(hb / alt).toFixed(2)})`);
}

// 4. Field decays as exp(-k*d) with k = 2*pi/lambda
{
  const pitch = 0.024;
  const h = decompose(ARRAY_TYPES.halbach1d.build({ pitch, thickness: 0.006, Br: 1.32, segments: 6 }), { maxOrder: 1, gapRef: 0.002 });
  const b1 = peakField(h, 0.002), b2 = peakField(h, 0.004);
  const kMeasured = Math.log(b1 / b2) / 0.002;
  const kExpected = (2 * Math.PI) / pitch;
  check('decay constant equals 2*pi/lambda', Math.abs(kMeasured / kExpected - 1) < 1e-6,
    `measured ${kMeasured.toFixed(1)} 1/m, expected ${kExpected.toFixed(1)} 1/m`);
}

// 5. Full machine: rank, linearity, symmetry, exponential lift falloff
{
  const tr = makeTranslator({
    arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.005,
    Br: 1.32, segments: 4, platenSize: 0.072, platenMass: 0, maxOrder: 3, gap: 0.0015,
  });
  const stator = makeStator({
    coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.20,
    turns: 60, layers: 1, wireDiameter: 5e-4, pcbLayers: 16,
    pcbTraceWidth: 2.5e-4, pcbCopperThickness: 70e-6, ringsPerCoil: 2, segmentsPerSide: 3,
  });
  console.log(`\n  platen mass ${(tr.mass * 1000).toFixed(1)} g, ${stator.coils.length} coils, ${tr.harm.n} harmonics, peak gap B ${tr.peakGapField.toFixed(3)} T`);

  const q = quat.identity();
  const Wm = buildWrench(stator, tr, [0, 0, 0.0015], q);
  check('active coils under platen', Wm.n > 20 && Wm.n < stator.coils.length, `${Wm.n} active`);

  const sv = singularValues(Wm, 0.036);
  check('wrench matrix has rank 6', sv[5] > 1e-6 * sv[0], `sigma ${sv.map((s) => s.toExponential(1)).join(' ')}`);

  // Linearity: doubling the commanded wrench doubles the currents.
  const a1 = allocate(Wm, [0, 0, 1, 0, 0, 0], { iMax: 1e9 });
  const a2 = allocate(Wm, [0, 0, 2, 0, 0, 0], { iMax: 1e9 });
  let maxDev = 0;
  for (let i = 0; i < a1.i.length; i++) maxDev = Math.max(maxDev, Math.abs(a2.i[i] - 2 * a1.i[i]));
  check('allocation is linear in the command', maxDev < 1e-9 * (a1.peak || 1), `max deviation ${maxDev.toExponential(2)}`);

  // Commanded pure lift must actually produce pure lift.
  const w = a1.achieved;
  const off = Math.max(Math.abs(w[0]), Math.abs(w[1])) / Math.abs(w[2]);
  check('pure-lift command yields pure lift', off < 1e-6, `lateral leakage ${off.toExponential(2)}`);
  check('lift direction is up for positive command', w[2] > 0, `Fz per unit command ${w[2].toFixed(6)}`);

  // Lift capability must fall off exponentially with gap at rate ~k.
  const k = (2 * Math.PI * Math.SQRT2) / 0.024; // 2-D checkerboard: k = sqrt(kx^2+ky^2)
  const c1 = capability(buildWrench(stator, tr, [0, 0, 0.0015], q), [0, 0, 1, 0, 0, 0], 4).magnitude;
  const c2 = capability(buildWrench(stator, tr, [0, 0, 0.0035], q), [0, 0, 1, 0, 0, 0], 4).magnitude;
  const kMeas = Math.log(c1 / c2) / 0.002;
  check('lift falls off at the harmonic decay rate', Math.abs(kMeas / k - 1) < 0.15,
    `measured ${kMeas.toFixed(0)}, expected ~${k.toFixed(0)} 1/m`);

  const a = analysePose(stator, tr, [0, 0, 0.0015], q, 4);
  console.log(`  lift margin ${a.liftMargin.toFixed(2)}x, accel ${(a.maxAccel / 9.81).toFixed(2)} g, hover ${a.hoverPower.toFixed(2)} W, cond ${a.conditionNumber.toFixed(1)}`);
  check('preset can actually hover', a.liftMargin > 1, `${a.liftMargin.toFixed(2)}x weight`);
}

// 6. Timing of the hot loop
{
  const tr = makeTranslator({
    arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.005,
    Br: 1.32, segments: 4, platenSize: 0.072, platenMass: 0, maxOrder: 3, gap: 0.0015,
  });
  const stator = makeStator({
    coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.20, turns: 60, layers: 1,
    wireDiameter: 5e-4, pcbLayers: 16, pcbTraceWidth: 2.5e-4, pcbCopperThickness: 70e-6,
    ringsPerCoil: 2, segmentsPerSide: 3,
  });
  const q = quat.identity();
  const t0 = process.hrtime.bigint();
  const N = 400;
  for (let i = 0; i < N; i++) {
    const Wm = buildWrench(stator, tr, [0.0001 * i, 0, 0.0015], q);
    allocate(Wm, [0, 0, 1, 0, 0, 0], { iMax: 4 });
  }
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`\n  buildWrench + allocate: ${us.toFixed(0)} us  ->  ${(1e6 / us).toFixed(0)} Hz max control rate`);
  check('control step is real-time capable at 600 Hz', us < 1667, `${us.toFixed(0)} us/step`);
}

// 7. Phase grouping: W_eff = W G must be exactly consistent with driving the
//    implied coil currents directly, and the four-array cross must keep yaw.
{
  const tr = mkTr({
    arrayType: 'halbach1d', layout: 'quad', pitch: 0.040, magnetThickness: 0.010,
    Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3, gap: 0.003,
  });
  const stator = makeStator({
    coilType: 'square', coilPitch: 0.0133, coilFill: 0.92, statorSize: 0.30,
    windingHeight: 0.010, wireDiameter: 4e-4, pcbLayers: 16, pcbTraceWidth: 2.5e-4,
    pcbCopperThickness: 70e-6, ringsPerCoil: 2, segmentsPerSide: 3,
  });
  const q = quat.identity();
  const base = buildWrench(stator, tr, [0, 0, 0.003], q);
  const grp = buildGrouping(stator, tr, [0, 0, 0.003], q, 'r1', base.idx);
  const Wg = groupWrench(base, grp);

  console.log(`\n  grouping: ${grp.nPhases} amplifiers driving ${grp.nCoils} live coils`);
  check('four-array cross yields the published 8 phases', grp.nPhases === 8, `${grp.nPhases}`);

  // w = (W G) u must equal W (G u) exactly -- the whole point of the composition.
  const u = new Float64Array(grp.nPhases);
  for (let p = 0; p < grp.nPhases; p++) u[p] = Math.cos(p * 1.7) * 0.5;
  const viaGrouped = wrenchOf(Wg, u);
  const viaCoils = wrenchOf(base, coilCurrents(Wg, u));
  let err = 0;
  for (let a = 0; a < 6; a++) err = Math.max(err, Math.abs(viaGrouped[a] - viaCoils[a]));
  const mag = Math.max(...viaCoils.map(Math.abs));
  check('W_eff = W G is exact', err < 1e-12 * Math.max(mag, 1), `max deviation ${err.toExponential(2)}`);

  // Tangential thrust is what gives this layout yaw authority. A radial layout
  // has r x F = 0 for every array and silently loses a degree of freedom.
  const sv = singularValues(Wg, 0.07);
  check('8 phases still control all 6 DOF', sv[5] > 1e-4 * sv[0],
    `cond ${(sv[0] / sv[5]).toFixed(1)}`);

  // A single group per array cannot make torque on a one-array platen.
  const tr1 = mkTr({
    arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.003,
    Br: 1.43, segments: 4, platenSize: 0.072, platenMass: 0, maxOrder: 3, gap: 0.0015,
  });
  const st1 = makeStator({
    coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.096,
    windingHeight: 0.0016, wireDiameter: 5e-4, pcbLayers: 16, pcbTraceWidth: 2.5e-4,
    pcbCopperThickness: 70e-6, ringsPerCoil: 2, segmentsPerSide: 3,
  });
  const b1 = buildWrench(st1, tr1, [0, 0, 0.0015], q);
  const g1 = buildGrouping(st1, tr1, [0, 0, 0.0015], q, 'r1', b1.idx);
  const s1 = singularValues(groupWrench(b1, g1), 0.036);
  check('one group on a single array is rank-deficient (as it must be)',
    s1[5] < 1e-6 * s1[0], `sigma_min/sigma_max = ${(s1[5] / s1[0]).toExponential(1)}`);
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
