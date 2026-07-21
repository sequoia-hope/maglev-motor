// Multi-dimensional design search.
//
// A 1-D sweep answers "what is the best pole pitch, holding everything else
// fixed?" -- which is the wrong question, because the optimum pole pitch depends
// on the air gap, which depends on the winding height, which trades against turn
// count. The variables are coupled, so they have to be searched together.
//
// Method: random sampling over the enabled dimensions to find the basin, then
// pattern search (coordinate refinement with a shrinking step) from the best few
// candidates. Not gradient-based -- the objective has discrete cliffs (coil
// counts are integers, grouping is categorical, rank can collapse) that
// derivatives handle badly.
//
// Everything is CONSTRAINED-then-ranked rather than a weighted sum of
// objectives. A weighted sum silently trades away a hard physical requirement
// for a soft one: no amount of low hover power compensates for a machine that
// cannot lift itself at some point in its workspace.

import { quat } from './math.js';
import { makeTranslator } from './halbach.js';
import { makeStator } from './coils.js';
import { analysePose } from './physics.js';
import { thermal } from './analysis.js';

// Coarse solver settings: the search evaluates thousands of designs, so it runs
// cheap and the winner is re-verified at full quality afterwards.
const SEARCH_QUALITY = { ringsPerCoil: 1, segmentsPerSide: 2, maxOrder: 2 };

/** Searchable dimensions. `coilPitchRatio` is virtual: it sets coil pitch as a
 *  fraction of pole pitch, which is how the ratio actually matters (lambda/3 is
 *  the three-phase choice, lambda/2 is the degenerate one). */
export const DIMENSIONS = {
  pitch: { label: 'Pole pitch λ', path: 'translator.pitch', min: 0.012, max: 0.070, unit: 'mm', scale: 1000 },
  magnetThickness: { label: 'Magnet thickness', path: 'translator.magnetThickness', min: 0.002, max: 0.015, unit: 'mm', scale: 1000 },
  platenSize: { label: 'Platen size', path: 'translator.platenSize', min: 0.05, max: 0.18, unit: 'mm', scale: 1000 },
  coilPitchRatio: { label: 'Coil pitch ratio λ/n', path: null, min: 1.8, max: 4.5, unit: '', scale: 1 },
  windingHeight: { label: 'Winding height', path: 'stator.windingHeight', min: 0.002, max: 0.015, unit: 'mm', scale: 1000, skipIf: (c) => c.stator.coilType === 'pcb' },
  wireDiameter: { label: 'Wire diameter', path: 'stator.wireDiameter', min: 0.0002, max: 0.0012, unit: 'mm', scale: 1000, skipIf: (c) => c.stator.coilType === 'pcb' },
  gap: { label: 'Air gap', path: 'sim.gap', min: 0.001, max: 0.008, unit: 'mm', scale: 1000 },
  iMax: { label: 'Current limit', path: 'sim.iMax', min: 1, max: 16, unit: 'A', scale: 1 },
};

export const CATEGORICAL = {
  grouping: { label: 'Drive grouping', path: 'sim.grouping', values: ['independent', 'r1', 'r2', 'r3'] },
};

export const OBJECTIVES = {
  accel: { label: 'Max lateral acceleration', better: 'max', get: (m) => m.accel, unit: 'g' },
  liftPerWatt: { label: 'Max lift per watt', better: 'max', get: (m) => m.worstLift / Math.max(m.hoverPower, 1e-6), unit: '×/W' },
  power: { label: 'Min hover power', better: 'min', get: (m) => m.hoverPower, unit: 'W' },
  lift: { label: 'Max worst-case lift margin', better: 'max', get: (m) => m.worstLift, unit: '×' },
  amplifiers: { label: 'Min amplifiers', better: 'min', get: (m) => m.amplifiers, unit: '' },
  mass: { label: 'Min platen mass', better: 'min', get: (m) => m.mass, unit: 'kg' },
};

export const DEFAULT_CONSTRAINTS = {
  minWorstLift: 1.5,     // must hover everywhere with margin to manoeuvre
  maxDeltaT: 40,         // K rise, natural convection
  maxCurrentDensity: 15, // A/mm^2 at hover
  maxAmplifiers: 256,
  requireRank6: true,
  // Air gap is not free to shrink. Stator flatness, platen flatness, thermal
  // expansion and control error all scale with the machine, so the achievable
  // gap scales with platen size. Without this the optimiser always drives the
  // gap to its lower bound -- force goes as exp(-k*gap), so of course it does --
  // and returns a machine that cannot be assembled.
  minGapFraction: 0.015, // gap >= 1.5% of platen size
  minGapAbsolute: 0.0005,
};

/** Current-density limits are not one number. A wound coil is a thick bundle
 *  cooled only at its surface; a PCB trace is thin but bonded to a laminate
 *  that spreads heat, and it is physically impossible to get much copper
 *  cross-section on a board. Holding PCB coils to a wound-coil limit rejects
 *  every PCB design ever built. */
export function constraintsFor(cfg, base = DEFAULT_CONSTRAINTS) {
  const pcb = cfg.stator.coilType === 'pcb';
  return { ...base, maxCurrentDensity: pcb ? 60 : 15 };
}

const get = (o, p) => p.split('.').reduce((a, k) => a[k], o);
const set = (o, p, v) => {
  const ks = p.split('.'); const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
};

/** Apply a candidate vector to a config clone. */
export function applyCandidate(cfg, cand) {
  const c = JSON.parse(JSON.stringify(cfg));
  for (const [k, v] of Object.entries(cand)) {
    if (k === 'coilPitchRatio') continue;
    if (CATEGORICAL[k]) { set(c, CATEGORICAL[k].path, v); continue; }
    const d = DIMENSIONS[k];
    if (d?.path) set(c, d.path, v);
  }
  // Coil pitch is always derived from the ratio so the two never disagree.
  const ratio = cand.coilPitchRatio ?? (c.translator.pitch / c.stator.coilPitch);
  c.stator.coilPitch = c.translator.pitch / ratio;
  // Keep the stator just big enough for the platen to move over: searching
  // huge stators only burns time building coils the platen never reaches.
  c.stator.statorSize = Math.min(0.4, Math.max(0.06, c.translator.platenSize * 2));
  return c;
}

/** Evaluate one design. Returns metrics plus a feasibility verdict.
 *  Worst-case lift is sampled over a patch spanning two coil pitches, because
 *  the capability ripple is periodic at the coil pitch -- a centred evaluation
 *  is a symmetry point and systematically flatters the design. */
export function evaluate(cfg, constraints = DEFAULT_CONSTRAINTS, quality = SEARCH_QUALITY) {
  let tr, stator;
  try {
    tr = makeTranslator({ ...cfg.translator, gap: cfg.sim.gap, maxOrder: quality.maxOrder });
    stator = makeStator({ ...cfg.stator, ringsPerCoil: quality.ringsPerCoil, segmentsPerSide: quality.segmentsPerSide });
  } catch (e) {
    return { feasible: false, reason: 'build failed' };
  }
  if (!stator.coils.length) return { feasible: false, reason: 'no coils' };

  const q = quat.identity();
  const span = cfg.stator.coilPitch * 2;
  const N = 3;
  let worstLift = Infinity, worstAcc = Infinity, maxPower = 0, worstSigma = Infinity;
  let a0 = null;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = (ix / N) * span, y = (iy / N) * span;
      const a = analysePose(stator, tr, [x, y, cfg.sim.gap], q, cfg.sim.iMax, cfg.sim.grouping);
      if (!a0) a0 = a;
      worstLift = Math.min(worstLift, a.liftMargin);
      worstAcc = Math.min(worstAcc, a.maxAccel / 9.80665);
      worstSigma = Math.min(worstSigma, a.sigmaMin / (a.sigma[0] || 1));
      if (isFinite(a.hoverPower) && a.hoverSaturated <= 1e-6) maxPower = Math.max(maxPower, a.hoverPower);
      else maxPower = Infinity;
    }
  }

  const J = (a0.hoverPeakCurrent ?? 0) / (stator.wireArea * 1e6);
  const dT = thermal(maxPower, cfg.stator.statorSize ** 2);
  const m = {
    worstLift, accel: worstAcc, hoverPower: maxPower, deltaT: dT,
    currentDensity: J, amplifiers: a0.amplifiers, coils: stator.coils.length,
    activeCoils: a0.activeCoils, cond: a0.conditionNumber, mass: tr.mass,
    peakB: tr.peakGapField, rank6: worstSigma > 1e-4,
  };

  const gapFloor = Math.max(constraints.minGapAbsolute ?? 0,
    (constraints.minGapFraction ?? 0) * cfg.translator.platenSize);
  m.gapFloor = gapFloor;

  const fails = [];
  if (!(m.peakB > 1e-4)) fails.push('no usable air-gap field');
  if (!isFinite(m.hoverPower)) fails.push('cannot hover within the current limit');
  if (!(cfg.sim.gap >= gapFloor - 1e-9)) fails.push('gap below buildable floor');
  if (!(m.worstLift >= constraints.minWorstLift)) fails.push('lift');
  if (!(m.deltaT <= constraints.maxDeltaT)) fails.push('thermal');
  if (!(m.currentDensity <= constraints.maxCurrentDensity)) fails.push('current density');
  if (!(m.amplifiers <= constraints.maxAmplifiers)) fails.push('amplifiers');
  if (constraints.requireRank6 && !m.rank6) fails.push('rank');
  m.feasible = fails.length === 0;
  m.reason = fails.join(', ');
  return m;
}

function score(m, objective) {
  const o = OBJECTIVES[objective];
  const v = o.get(m);
  if (!isFinite(v)) return -Infinity;
  return o.better === 'max' ? v : -v;
}

/** Is `a` at least as good as `b` on every axis, and better on one?
 *  Used to reduce the evaluated set to its Pareto front. */
function dominates(a, b) {
  const axes = [
    [a.accel, b.accel, 1], [a.worstLift, b.worstLift, 1],
    [-a.hoverPower, -b.hoverPower, 1], [-a.amplifiers, -b.amplifiers, 1],
  ];
  let strictly = false;
  for (const [x, y] of axes) {
    if (!(x >= y - 1e-12)) return false;
    if (x > y + 1e-12) strictly = true;
  }
  return strictly;
}

export function paretoFront(results) {
  const f = results.filter((r) => r.m.feasible);
  return f.filter((r) => !f.some((o) => o !== r && dominates(o.m, r.m)));
}

function sample(dims, cats, rnd) {
  const c = {};
  for (const [k, d] of Object.entries(dims)) c[k] = d.min + (d.max - d.min) * rnd();
  for (const [k, d] of Object.entries(cats)) c[k] = d.values[Math.floor(rnd() * d.values.length)];
  return c;
}

/** Deterministic PRNG so a search is reproducible and re-runnable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generator-based search so the caller can yield to the UI between
 *  evaluations. Yields progress; returns the ranked result set. */
export function* search(baseCfg, spec) {
  const {
    dims, cats, objective, constraints,
    samples = 400, refineFrom = 6, refineSteps = 5, seed = 12345,
  } = spec;
  const rnd = mulberry32(seed);
  const results = [];
  let evaluated = 0;

  const run = (cand) => {
    const cfg = applyCandidate(baseCfg, cand);
    const m = evaluate(cfg, constraints);
    const r = { cand, cfg, m, score: m.feasible ? score(m, objective) : -Infinity };
    results.push(r);
    evaluated++;
    return r;
  };

  // Phase 1: find the basins.
  for (let i = 0; i < samples; i++) {
    run(sample(dims, cats, rnd));
    if (i % 8 === 0) yield { phase: 'explore', evaluated, total: samples, best: bestOf(results) };
  }
  yield { phase: 'explore', evaluated, total: samples, best: bestOf(results) };

  // Phase 2: pattern search from the best feasible candidates.
  const seeds = results.filter((r) => r.m.feasible)
    .sort((a, b) => b.score - a.score).slice(0, refineFrom);
  const keys = Object.keys(dims);
  const totalRefine = seeds.length * refineSteps * keys.length * 2;
  let done = 0;

  for (const s0 of seeds) {
    let cur = { ...s0.cand };
    let curScore = s0.score;
    let step = 0.25;
    for (let it = 0; it < refineSteps; it++) {
      let improved = false;
      for (const k of keys) {
        const d = dims[k];
        for (const dir of [1, -1]) {
          const trial = { ...cur };
          trial[k] = Math.min(d.max, Math.max(d.min, cur[k] + dir * step * (d.max - d.min)));
          if (trial[k] === cur[k]) { done++; continue; }
          const r = run(trial);
          done++;
          if (r.score > curScore) { cur = trial; curScore = r.score; improved = true; }
          if (done % 8 === 0) {
            yield { phase: 'refine', evaluated, total: totalRefine, done, best: bestOf(results) };
          }
        }
      }
      if (!improved) step /= 2; // no direction helped: look closer in
    }
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0] ?? null;
  // Which constraint is doing the blocking? With zero feasible designs this is
  // the only actionable information the search can give back.
  const failures = {};
  for (const r of results) {
    if (r.m.feasible) continue;
    for (const f of (r.m.reason || 'unknown').split(', ')) failures[f] = (failures[f] || 0) + 1;
  }
  return {
    results, best, pareto: paretoFront(results), evaluated, failures,
    activeBounds: best && isFinite(best.score) ? activeBounds(best.cand, dims) : [],
  };
}

/** Dimensions whose optimum is sitting on a search bound. When a variable is
 *  pinned, the bound is deciding the design, not the physics -- the user needs
 *  to know that so they can widen it or accept it as a real constraint. */
export function activeBounds(cand, dims, tol = 0.02) {
  const out = [];
  for (const [k, d] of Object.entries(dims)) {
    const v = cand[k];
    if (v === undefined) continue;
    const span = d.max - d.min;
    if (v <= d.min + span * tol) out.push({ key: k, label: d.label, at: 'min', value: v });
    else if (v >= d.max - span * tol) out.push({ key: k, label: d.label, at: 'max', value: v });
  }
  return out;
}

function bestOf(results) {
  let b = null;
  for (const r of results) if (!b || r.score > b.score) b = r;
  return b && isFinite(b.score) ? b : null;
}
