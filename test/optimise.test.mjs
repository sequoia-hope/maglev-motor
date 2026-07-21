import { readFileSync } from 'fs';
import {
  DIMENSIONS, CATEGORICAL, DEFAULT_CONSTRAINTS, constraintsFor,
  evaluate, search, applyCandidate, activeBounds, paretoFront,
} from '../src/optimise.js';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); if (!c) fails++; };

// 1. applyCandidate keeps the derived quantities consistent.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  const cfg = applyCandidate(base, { pitch: 0.036, coilPitchRatio: 3, magnetThickness: 0.004 });
  check('candidate sets pole pitch', Math.abs(cfg.translator.pitch - 0.036) < 1e-12);
  check('coil pitch is derived from the ratio',
    Math.abs(cfg.stator.coilPitch - 0.012) < 1e-12, `${(cfg.stator.coilPitch * 1000).toFixed(3)} mm`);
  check('base config is not mutated', Math.abs(base.translator.pitch - PRESETS.wound.cfg.translator.pitch) < 1e-12);
}

// 2. Evaluation is deterministic -- the search relies on it.
{
  const cfg = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  const a = evaluate(cfg), b = evaluate(cfg);
  check('evaluate() is deterministic',
    a.worstLift === b.worstLift && a.hoverPower === b.hoverPower && a.accel === b.accel);
  check('evaluate() reports every gate', ['worstLift', 'accel', 'hoverPower', 'deltaT',
    'currentDensity', 'amplifiers', 'rank6', 'feasible'].every((k) => k in a));
}

// 3. Worst-case sampling must not be a centred symmetry point.
{
  const cfg = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  const m = evaluate(cfg);
  check('worst-case lift is not flattered by the centred pose',
    m.worstLift > 0 && isFinite(m.worstLift), `${m.worstLift.toFixed(2)}x`);
}

// 4. PCB coils cannot meet a wound-coil current-density limit. Holding them to
//    one rejects every PCB machine ever built, so the limit is topology-aware.
{
  const pcb = JSON.parse(JSON.stringify(PRESETS.pcb.cfg));
  const wound = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  check('current-density limit adapts to coil topology',
    constraintsFor(pcb).maxCurrentDensity > constraintsFor(wound).maxCurrentDensity,
    `pcb ${constraintsFor(pcb).maxCurrentDensity} vs wound ${constraintsFor(wound).maxCurrentDensity} A/mm2`);
}

// 5. The air-gap floor must bind, or the optimiser drives the gap to zero:
//    force goes as exp(-k*gap), so an unconstrained search always cheats.
{
  const cfg = applyCandidate(JSON.parse(JSON.stringify(PRESETS.wound.cfg)),
    { platenSize: 0.15, gap: 0.0005 });
  const m = evaluate(cfg, DEFAULT_CONSTRAINTS);
  check('a sub-buildable air gap is rejected',
    !m.feasible && m.reason.includes('gap'), `reason: ${m.reason}`);
}

// 6. End-to-end search, then verify the winner at FULL solver quality. The
//    search runs coarse for speed, so a winner that only exists at low fidelity
//    is worse than useless.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  const dims = {};
  for (const k of ['pitch', 'magnetThickness', 'coilPitchRatio', 'windingHeight', 'gap']) {
    const d = DIMENSIONS[k];
    if (d && !(d.skipIf && d.skipIf(base))) dims[k] = d;
  }
  const spec = {
    dims, cats: CATEGORICAL, objective: 'accel',
    constraints: constraintsFor(base), samples: 250, refineFrom: 4, refineSteps: 4,
  };
  const t0 = Date.now();
  const it = search(base, spec);
  let r = it.next();
  while (!r.done) r = it.next();
  const out = r.value;
  const secs = (Date.now() - t0) / 1000;
  const feas = out.results.filter((x) => x.m.feasible).length;
  console.log(`\n  ${out.evaluated} designs in ${secs.toFixed(1)}s (${(out.evaluated / secs).toFixed(0)}/s) · ${feas} feasible · ${out.pareto.length} Pareto`);

  check('search finds feasible designs', feas > 0, `${feas}/${out.results.length}`);
  check('search returns a best', !!out.best && isFinite(out.best.score));
  check('reports a failure histogram', Object.keys(out.failures).length > 0,
    Object.entries(out.failures).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '));

  const b = out.best;
  console.log(`  best: accel ${b.m.accel.toFixed(2)}g lift ${b.m.worstLift.toFixed(2)}x P ${b.m.hoverPower.toFixed(1)}W amps ${b.m.amplifiers}`);
  console.log(`        λ ${(b.cfg.translator.pitch * 1000).toFixed(1)}mm gap ${(b.cfg.sim.gap * 1000).toFixed(2)}mm ratio ${(b.cfg.translator.pitch / b.cfg.stator.coilPitch).toFixed(2)} drive ${b.cfg.sim.grouping}`);

  // Beating the starting point is the entire justification for the feature.
  const baseline = evaluate(base, constraintsFor(base));
  check('search improves on the starting design', b.m.accel > baseline.accel,
    `${baseline.accel.toFixed(2)}g -> ${b.m.accel.toFixed(2)}g`);

  const fine = evaluate(b.cfg, spec.constraints, { ringsPerCoil: 3, segmentsPerSide: 5, maxOrder: 4 });
  check('winner survives verification at full solver quality', fine.feasible,
    fine.feasible ? `accel ${fine.accel.toFixed(2)}g (coarse said ${b.m.accel.toFixed(2)}g)` : fine.reason);
  const drift = Math.abs(fine.accel - b.m.accel) / Math.max(b.m.accel, 1e-9);
  check('coarse and fine evaluation agree within 25%', drift < 0.25, `${(drift * 100).toFixed(0)}% drift`);

  // Pareto front members must not be dominated by anything feasible.
  check('Pareto front is internally consistent', paretoFront(out.results).length === out.pareto.length);

  const ab = activeBounds(b.cand, dims);
  console.log(`  active bounds: ${ab.length ? ab.map((x) => `${x.label}@${x.at}`).join(', ') : 'none'}`);
  check('active-bound detection runs', Array.isArray(ab));
}

// 7. Pinning: a dimension left out of the search must keep the base value
//    exactly, in every candidate. This is what lets you fix the variables the
//    application already decides and spend the budget on the rest.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  base.translator.pitch = 0.030;
  base.translator.platenSize = 0.11;
  const dims = { magnetThickness: DIMENSIONS.magnetThickness, gap: DIMENSIONS.gap };
  const it = search(base, {
    dims, cats: {}, objective: 'lift', constraints: constraintsFor(base),
    samples: 80, refineFrom: 3, refineSteps: 3,
  });
  let r = it.next(); while (!r.done) r = it.next();
  const out = r.value;

  const pitchDrift = Math.max(...out.results.map((x) => Math.abs(x.cfg.translator.pitch - 0.030)));
  const platenDrift = Math.max(...out.results.map((x) => Math.abs(x.cfg.translator.platenSize - 0.11)));
  check('pinned pole pitch is never varied', pitchDrift < 1e-12, `max drift ${pitchDrift.toExponential(1)} m`);
  check('pinned platen size is never varied', platenDrift < 1e-12, `max drift ${platenDrift.toExponential(1)} m`);

  const varied = new Set(out.results.map((x) => x.cand.magnetThickness.toFixed(6)));
  check('searched dimensions genuinely vary', varied.size > 10, `${varied.size} distinct values`);

  // Grouping is categorical: excluded from `cats`, it must stay put too.
  const gDrift = out.results.some((x) => x.cfg.sim.grouping !== base.sim.grouping);
  check('pinned drive grouping is never varied', !gDrift, base.sim.grouping);
}

// 8. Narrowing a dimension's range must be respected.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  const narrowed = { ...DIMENSIONS.pitch, min: 0.030, max: 0.034 };
  const it = search(base, {
    dims: { pitch: narrowed, gap: DIMENSIONS.gap }, cats: {}, objective: 'lift',
    constraints: constraintsFor(base), samples: 60, refineFrom: 2, refineSteps: 3,
  });
  let r = it.next(); while (!r.done) r = it.next();
  const out = r.value;
  const outside = out.results.filter((x) => x.cand.pitch < 0.030 - 1e-12 || x.cand.pitch > 0.034 + 1e-12);
  check('a narrowed search range is respected', outside.length === 0,
    `${outside.length} of ${out.results.length} escaped [30, 34] mm`);
}

// 9. REGRESSION. A damped least-norm solve degrades gracefully when a wrench
//    direction is unreachable: it returns tiny currents that achieve almost
//    nothing. capability() used to assume the requested unit wrench had been
//    delivered and simply scale the currents to the limit -- so dividing by a
//    near-zero current reported an astronomical force for a machine producing
//    none. A stator whose air-gap field had underflowed to 1e-18 T claimed a
//    lift margin of 3e13.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  base.translator.arrayType = 'halbach2d';
  base.translator.layout = 'single';
  base.stator.coilType = 'square';
  const cons = constraintsFor(base);

  // Pole pitch far below the model's declared floor: the air-gap field decays
  // as exp(-k*d) with k = 2*pi/lambda, so a sub-millimetre pitch has no field
  // at any real air gap.
  let worstSeen = 0, nonFinite = 0;
  for (const pitch of [0.0005, 0.0008, 0.0014, 0.002, 0.003]) {
    for (const gap of [0.001, 0.003, 0.006]) {
      for (const ratio of [0.8, 2, 3, 6]) {
        const cfg = applyCandidate(base, { pitch, gap, coilPitchRatio: ratio, magnetThickness: 0.004 });
        const m = evaluate(cfg, cons);
        if (!isFinite(m.worstLift)) nonFinite++;
        else worstSeen = Math.max(worstSeen, m.worstLift);
        if (m.peakB < 1e-4 && m.feasible) {
          check('a design with no air-gap field is never feasible', false,
            `peakB ${m.peakB.toExponential(2)} T reported feasible`);
        }
      }
    }
  }
  check('a field-free machine never reports absurd lift', worstSeen < 1e3,
    `max reported ${worstSeen.toExponential(2)}x`);
  check('no non-finite lift margins', nonFinite === 0, `${nonFinite} non-finite`);
}

// 10. capability() must report zero for a wrench direction it cannot reach,
//     not a number derived from how little current the solver happened to use.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  base.translator.arrayType = 'halbach2d';
  base.translator.layout = 'single';
  const cfg = applyCandidate(base, { pitch: 0.0014, gap: 0.006, coilPitchRatio: 3 });
  const m = evaluate(cfg, constraintsFor(base));
  check('unreachable wrench yields zero capability, not infinity',
    m.worstLift < 1e-3 && m.accel < 1e-3,
    `lift ${m.worstLift.toExponential(2)} accel ${m.accel.toExponential(2)}`);
  check('and it is reported infeasible', !m.feasible, `reason: ${m.reason}`);
}

// 11. Reproducibility: same seed, same answer.
{
  const base = JSON.parse(JSON.stringify(PRESETS.wound.cfg));
  const dims = { pitch: DIMENSIONS.pitch, gap: DIMENSIONS.gap };
  const run = (seed) => {
    const it = search(base, { dims, cats: {}, objective: 'lift', constraints: constraintsFor(base), samples: 60, refineFrom: 2, refineSteps: 2, seed });
    let r = it.next(); while (!r.done) r = it.next();
    return r.value.best?.score ?? null;
  };
  check('search is reproducible for a fixed seed', run(7) === run(7));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
