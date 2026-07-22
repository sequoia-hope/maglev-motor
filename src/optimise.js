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

import { makeTranslator, applyMagnetDrive, nearestStockMagnet } from './halbach.js';
import { makeStator } from './coils.js';
import { analysePose } from './physics.js';
import { stackUp, stackTemperatureRise, mechDefaultsFor } from './mechanical.js';

// Coarse solver settings: the search evaluates thousands of designs, so it runs
// cheap and the winner is re-verified at full quality afterwards.
const SEARCH_QUALITY = { ringsPerCoil: 1, segmentsPerSide: 2, maxOrder: 2 };

/** Searchable dimensions. `coilPitchRatio` is virtual: it sets coil pitch as a
 *  fraction of pole pitch, which is how the ratio actually matters (lambda/3 is
 *  the three-phase choice, lambda/2 is the degenerate one). */
export const DIMENSIONS = {
  pitch: { label: 'Pole pitch λ', path: 'translator.pitch', min: 0.012, max: 0.070, unit: 'mm', scale: 1000,
    // When the magnet is the input, the pitch is an output. Searching it too
    // would let the search propose a pitch its own magnets cannot produce.
    skipIf: (c) => c.translator.driveByMagnet },
  // Stock sizes only. `snap` is applied to every sampled and refined value, so
  // the search cannot wander onto a 5.2 mm magnet nobody sells.
  magnetSize: { label: 'Magnet size (stock)', path: 'translator.magnetSize',
    min: 0.002, max: 0.025, unit: 'mm', scale: 1000, snap: nearestStockMagnet,
    skipIf: (c) => !c.translator.driveByMagnet },
  // With the magnet fixed, this is the ONLY way to move the pole pitch, which
  // makes it a first-class search variable rather than a modelling detail.
  segments: { label: 'Magnets per wavelength', path: 'translator.segments',
    min: 2, max: 8, unit: '', scale: 1, snap: Math.round },
  magnetThickness: { label: 'Magnet thickness', path: 'translator.magnetThickness', min: 0.002, max: 0.015, unit: 'mm', scale: 1000,
    skipIf: (c) => c.translator.driveByMagnet && c.translator.cubicMagnets },
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
  // Air gap is the hardest thing to buy on a real machine -- force falls as
  // exp(-k*gap), so everything else is spent purchasing it. Maximising the gap
  // subject to a lift floor is usually the most useful question for a small
  // build, where flatness and assembly tolerance dominate.
  gap: { label: 'Max air gap (most buildable)', better: 'max', get: (m) => m.gap * 1000, unit: 'mm' },
  liftPerWatt: { label: 'Max lift per watt', better: 'max', get: (m) => m.worstLift / Math.max(m.hoverPower, 1e-6), unit: '×/W' },
  // A square coil grid under a square magnet array is at its most favourable
  // when the two are aligned; 45 degrees is the far corner of yaw, where the
  // array's periodicity is sqrt(2) out of step with the coils'. Optimising
  // there instead of at 0 buys a machine that does not quietly get worse as it
  // rotates. Declaring the extra angle here is what makes evaluate() sample it,
  // so nothing pays for the second pose sweep unless this objective is chosen.
  liftPerWattYaw45: {
    label: 'Max lift per watt at 45° yaw', better: 'max', unit: '×/W',
    yaws: [0, Math.PI / 4],
    get: (m) => {
      const y = m.yaw?.[45];
      return y ? y.worstLift / Math.max(y.hoverPower, 1e-6) : NaN;
    },
  },
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
  // Coil count is the labour gate on a hand-wound stator: 500 coils is a
  // year of evenings, whatever the physics says.
  maxCoils: 512,
  requireRank6: true,
  // Air gap is not free to shrink. Stator flatness, platen flatness, thermal
  // expansion and control error all scale with the machine, so the achievable
  // gap scales with platen size. Without this the optimiser always drives the
  // gap to its lower bound -- force goes as exp(-k*gap), so of course it does --
  // and returns a machine that cannot be assembled.
  // The air-gap floor now comes from the mechanical tolerance stack; this is
  // only an absolute backstop.
  minGapAbsolute: 0.0003,
  maxWallStress: 60e6,   // Pa, retainer walls under magnet-to-magnet load
};

/** Current-density limits are not one number. A wound coil is a thick bundle
 *  cooled only at its surface; a PCB trace is thin but bonded to a laminate
 *  that spreads heat, and it is physically impossible to get much copper
 *  cross-section on a board. Holding PCB coils to a wound-coil limit rejects
 *  every PCB design ever built. */
export function constraintsFor(cfg, base = DEFAULT_CONSTRAINTS) {
  const pcb = cfg.stator.coilType === 'pcb';
  // If the point of the design is that the magnets come off a shelf, then a
  // design needing custom magnetisation has not solved the problem it was set.
  // Without this the search cheerfully returns 5 mm cubes at seven segments per
  // wavelength -- stock size, bespoke magnetisation, 120 custom parts.
  return {
    ...base,
    maxCurrentDensity: pcb ? 60 : 15,
    requireStockMagnets: base.requireStockMagnets ?? !!cfg.translator.driveByMagnet,
  };
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
  // Magnet-driven designs derive their pitch from the magnet, and everything
  // below reads pitch -- so this has to happen before the coil pitch is set.
  applyMagnetDrive(c.translator);
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
export function evaluate(cfg, constraints = DEFAULT_CONSTRAINTS, quality = SEARCH_QUALITY, yaws = [0]) {
  let tr, stator;
  // The mechanical stack supplies platen mass, the air-gap floor and the
  // thermal path. All three used to be invented constants.
  const stack = stackUp(cfg, { ...mechDefaultsFor(cfg), ...(cfg.mech ?? {}) });
  try {
    tr = makeTranslator({
      ...cfg.translator,
      platenMass: cfg.translator.platenMass || stack.platenMass,
      gap: cfg.sim.gap, maxOrder: quality.maxOrder,
    });
    stator = makeStator({ ...cfg.stator, ringsPerCoil: quality.ringsPerCoil, segmentsPerSide: quality.segmentsPerSide });
  } catch (e) {
    return { feasible: false, reason: 'build failed' };
  }
  if (!stator.coils.length) return { feasible: false, reason: 'no coils' };

  const span = cfg.stator.coilPitch * 2;
  const N = 3;
  let worstLift = Infinity, worstAcc = Infinity, maxPower = 0, worstSigma = Infinity;
  let a0 = null;
  const byYaw = [];
  for (const yaw of yaws) {
    // Yaw about z. The platen's own axes rotate away from the coil grid's, so
    // this is a genuinely different machine to commutate, not the same one
    // relabelled -- which is exactly why it is worth sampling.
    const h = yaw / 2;
    const q = [Math.cos(h), 0, 0, Math.sin(h)];
    let yLift = Infinity, yPower = 0;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const x = (ix / N) * span, y = (iy / N) * span;
        const a = analysePose(stator, tr, [x, y, cfg.sim.gap], q, cfg.sim.iMax, cfg.sim.grouping);
        if (!a0) a0 = a;
        worstLift = Math.min(worstLift, a.liftMargin);
        worstAcc = Math.min(worstAcc, a.maxAccel / 9.80665);
        worstSigma = Math.min(worstSigma, a.sigmaMin / (a.sigma[0] || 1));
        yLift = Math.min(yLift, a.liftMargin);
        if (isFinite(a.hoverPower) && a.hoverSaturated <= 1e-6) {
          maxPower = Math.max(maxPower, a.hoverPower);
          yPower = Math.max(yPower, a.hoverPower);
        } else { maxPower = Infinity; yPower = Infinity; }
      }
    }
    byYaw.push({ yaw, worstLift: yLift, hoverPower: yPower });
  }

  const J = (a0.hoverPeakCurrent ?? 0) / (stator.wireArea * 1e6);
  const dT = stackTemperatureRise(maxPower, stack);
  const m = {
    worstLift, accel: worstAcc, hoverPower: maxPower, deltaT: dT,
    currentDensity: J, amplifiers: a0.amplifiers, coils: stator.coils.length,
    gap: cfg.sim.gap,
    activeCoils: a0.activeCoils, cond: a0.conditionNumber, mass: tr.mass,
    peakB: tr.peakGapField, rank6: worstSigma > 1e-4,
    stack, wallStress: stack.wallStress, neighbourForce: stack.neighbourForce,
    stockMagnets: tr.stockMagnetised,
    // Per-yaw breakdown, so an objective can ask about one orientation while
    // feasibility still answers for the worst of all of them.
    byYaw,
    yaw: Object.fromEntries(byYaw.map((y) => [Math.round((y.yaw * 180) / Math.PI), y])),
  };

  // Computed from the tolerance stack, not from a fraction of the platen.
  const gapFloor = Math.max(constraints.minGapAbsolute ?? 0, stack.gapFloor);
  m.gapFloor = gapFloor;
  m.gapTerms = stack.terms;

  // Order matters, and so does not double-reporting: a design that cannot
  // hover has infinite hover power, which would otherwise ALSO be counted as a
  // thermal failure and bury the real blocker in the histogram.
  const fails = [];
  const cannotHover = !isFinite(m.hoverPower);
  if (!(m.peakB > 1e-4)) fails.push('no usable air-gap field');
  if (cannotHover) fails.push('cannot hover within the current limit');
  if (!(cfg.sim.gap >= gapFloor - 1e-9)) fails.push('gap below buildable floor');
  if (!(m.worstLift >= constraints.minWorstLift)) fails.push('lift');
  if (!cannotHover && !(m.deltaT <= constraints.maxDeltaT)) fails.push('thermal');
  if (!(m.currentDensity <= constraints.maxCurrentDensity)) fails.push('current density');
  if (!(m.amplifiers <= constraints.maxAmplifiers)) fails.push('amplifiers');
  if (!(m.coils <= (constraints.maxCoils ?? Infinity))) fails.push('coil count');
  if (!(m.wallStress <= (constraints.maxWallStress ?? Infinity))) fails.push('magnet retainer stress');
  if (constraints.requireRank6 && !m.rank6) fails.push('rank');
  if (constraints.requireStockMagnets && !m.stockMagnets) fails.push('needs custom-magnetised magnets');
  m.feasible = fails.length === 0;
  m.reason = fails.join(', ');
  return m;
}

/** How badly a design misses feasibility, normalised per constraint so the
 *  terms are commensurate. Only meaningful for infeasible designs. */
export function violation(m, cons) {
  if (!m || m.feasible) return 0;
  let v = 0;
  if (!(m.peakB > 1e-4)) v += 10;                       // no machine at all
  if (!isFinite(m.hoverPower)) v += 10;                 // cannot hover
  else v += Math.max(0, m.deltaT / cons.maxDeltaT - 1);
  v += Math.max(0, 1 - m.worstLift / Math.max(cons.minWorstLift, 1e-9));
  v += Math.max(0, m.currentDensity / cons.maxCurrentDensity - 1);
  v += Math.max(0, m.amplifiers / cons.maxAmplifiers - 1);
  v += Math.max(0, m.coils / (cons.maxCoils ?? Infinity) - 1);
  v += Math.max(0, m.wallStress / (cons.maxWallStress ?? Infinity) - 1);
  if (cons.requireRank6 && !m.rank6) v += 1;
  if (cons.requireStockMagnets && !m.stockMagnets) v += 1;
  return isFinite(v) ? v : 1e6;
}

/** Feasibility first, then objective. A feasible design always beats an
 *  infeasible one; among infeasible ones, less violation wins. Without this
 *  the refinement stage can only start from candidates that are ALREADY
 *  feasible -- so when random sampling happens to find none, the search
 *  reports "no feasible design" while good designs sit a short walk away. On a
 *  small platen, where the feasible region is a thin corner of the space, that
 *  is the normal case rather than the exception. */
function better(a, b) {
  if (!b) return true;
  const fa = a.m.feasible ? 1 : 0, fb = b.m.feasible ? 1 : 0;
  if (fa !== fb) return fa > fb;
  return fa ? a.score > b.score : a.viol < b.viol;
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

/** Some dimensions are not continuous: a magnet comes in stock sizes and a
 *  wavelength contains a whole number of them. Snapping at the point of
 *  sampling keeps the rest of the search oblivious to the difference. */
const snapped = (d, v) => {
  const s = d.snap ? d.snap(v) : v;
  return Math.min(d.max, Math.max(d.min, s));
};

function sample(dims, cats, rnd) {
  const c = {};
  for (const [k, d] of Object.entries(dims)) c[k] = snapped(d, d.min + (d.max - d.min) * rnd());
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

  // An objective may need poses the default sweep does not visit. Ask it once,
  // here, rather than making every caller remember.
  const yaws = OBJECTIVES[objective]?.yaws ?? [0];

  const run = (cand) => {
    const cfg = applyCandidate(baseCfg, cand);
    const m = evaluate(cfg, constraints, SEARCH_QUALITY, yaws);
    const r = {
      cand, cfg, m,
      score: m.feasible ? score(m, objective) : -Infinity,
      viol: violation(m, constraints),
    };
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

  // Phase 2: pattern search. Seeds are ranked feasibility-first, so if nothing
  // is feasible yet the search walks downhill on constraint violation until it
  // reaches the feasible region, then switches to optimising the objective.
  const seeds = results.slice()
    .sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0))
    .slice(0, refineFrom);
  const keys = Object.keys(dims);
  const totalRefine = seeds.length * refineSteps * keys.length * 2;
  let done = 0;

  for (const s0 of seeds) {
    let cur = { ...s0.cand };
    let curRef = s0;
    let step = 0.25;
    for (let it = 0; it < refineSteps; it++) {
      let improved = false;
      for (const k of keys) {
        const d = dims[k];
        for (const dir of [1, -1]) {
          const trial = { ...cur };
          trial[k] = snapped(d, cur[k] + dir * step * (d.max - d.min));
          if (trial[k] === cur[k]) { done++; continue; }
          const r = run(trial);
          done++;
          if (better(r, curRef)) { cur = trial; curRef = r; improved = true; }
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
  for (const r of results) if (r.m.feasible && (!b || r.score > b.score)) b = r;
  return b;
}
