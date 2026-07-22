// The exploded drawing is only worth anything if it cannot disagree with the
// simulation. These checks pin the two together: same masses, same magnet
// count, same air gap, and a stack that actually closes with no gaps or
// interpenetrating parts.

import { makeTranslator, ARRAY_TYPES, layoutPatches, patchFill, configFill, selfTest, eachCell } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { stackUp, mechDefaultsFor, DEFAULT_MECH } from '../src/mechanical.js';
import { buildAssembly, magnetCensus, nearestGrade, nearestAWG } from '../src/assembly.js';
import { latticeCount, arraySymmetry } from '../src/halbach.js';
import { readFileSync } from 'fs';

const src = readFileSync('../src/app.js', 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const Q = { fast: { segmentsPerSide: 2, ringsPerCoil: 1, maxOrder: 2 },
  balanced: { segmentsPerSide: 3, ringsPerCoil: 2, maxOrder: 3 },
  accurate: { segmentsPerSide: 5, ringsPerCoil: 3, maxOrder: 4 } };

let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fails++; };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// The half-cell shift of the tile origin is now IMPLEMENTED, not merely
// recommended: halbach.js samples the axis-aligned arrays at the cell edge.
// The claim that justified it -- same field, stock magnets instead of custom --
// still has to hold, so it stays checked rather than asserted. The shift is a
// rigid translation of the magnetisation, so every harmonic keeps its magnitude
// and only its phase moves.
console.log('=== the half-cell shift is real, and it costs nothing ===');
{
  const seg = 4, lx = 0.04, Br = 1.32, k = (2 * Math.PI) / lx;
  const build = (off) => Array.from({ length: seg }, (_, p) => {
    const x = ((p + off) / seg) * lx;
    const m = [-Math.sin(k * x), 0, Math.cos(k * x)];
    const n = Math.hypot(m[0], m[1], m[2]);
    return [(m[0] / n) * Br, 0, (m[2] / n) * Br];
  });
  const fundamental = (c) => {
    let zr = 0, zi = 0, xr = 0, xi = 0;
    for (let p = 0; p < seg; p++) {
      const ph = k * ((p + 0.5) / seg) * lx;
      zr += c[p][2] * Math.cos(ph); zi += c[p][2] * Math.sin(ph);
      xr += c[p][0] * Math.cos(ph); xi += c[p][0] * Math.sin(ph);
    }
    return { Mz: Math.hypot(zr, zi) / seg, Mx: Math.hypot(xr, xi) / seg };
  };
  const centre = build(0.5), edge = build(0);
  const a = fundamental(centre), b = fundamental(edge);
  const elev = (m) => Math.abs((Math.asin(m[2] / Math.hypot(m[0], m[1], m[2])) * 180) / Math.PI);
  check('centre sampling puts every block on a diagonal',
    centre.every((m) => elev(m) > 20 && elev(m) < 70), `elevations ${centre.map((m) => elev(m).toFixed(0)).join(', ')}°`);
  check('shifted by half a cell, every block is on an axis',
    edge.every((m) => elev(m) < 1e-9 || elev(m) > 90 - 1e-9), `elevations ${edge.map((m) => elev(m).toFixed(0)).join(', ')}°`);
  check('the shift leaves the fundamental amplitude unchanged',
    Math.abs(a.Mz - b.Mz) / a.Mz < 1e-12 && Math.abs(a.Mx - b.Mx) / a.Mx < 1e-12,
    `|Mz1| ${a.Mz.toFixed(6)} vs ${b.Mz.toFixed(6)}`);

  // ...and the shipped array builder is the shifted one, at the same field.
  const args = { pitch: lx, thickness: 0.006, Br, segments: seg };
  const built = ARRAY_TYPES.halbach1d.build(args);
  const elevOf = (i) => {
    const m = [built.cells[3 * i], built.cells[3 * i + 1], built.cells[3 * i + 2]];
    return Math.abs((Math.asin(m[2] / Math.hypot(...m)) * 180) / Math.PI);
  };
  check('the 1-D builder ships blocks on axes, not diagonals',
    [0, 1, 2, 3].every((i) => elevOf(i) < 1e-9 || elevOf(i) > 90 - 1e-9),
    `elevations ${[0, 1, 2, 3].map((i) => elevOf(i).toFixed(0)).join(', ')}°`);
  const self = selfTest({ ...args });
  check('and still matches the closed-form Halbach fundamental',
    self.pass, `${(self.relError * 100).toFixed(3)}% from analytic`);

  // The checkerboard's nulls are real empty pockets, not zero-field magnets.
  // One cell in four is a null in the INFINITE pattern, but a finite symmetric
  // array does not inherit that ratio: an odd (2N+1)-cell array is symmetric
  // precisely because both ends share a parity, and that parity decides whether
  // the rim rows are the half-empty ones. N odd puts voids in all four corners
  // and gives (N+1)^2 of them; N even puts the vertical blocks there and gives
  // N^2. Both are hand-checkable, and neither is 3/4.
  const cbCfg = { arrayType: 'halbach2d', pitch: 0.024, magnetThickness: 0.003, Br: 1.43,
    segments: 4, layout: 'single', platenSize: 0.072 };
  const cb = ARRAY_TYPES.halbach2d.build({ pitch: 0.024, thickness: 0.003, Br: 1.43, segments: 4 });
  const cbFill = patchFill(cb, layoutPatches('single', 0.072));
  // 72 mm of 6 mm cells: 11 cells, N = 5, so 36 voids in 121 pockets.
  check('the 2-D checkerboard leaves the pattern nulls empty',
    Math.abs(cbFill - 85 / 121) < 1e-12, `fill ${(cbFill * 100).toFixed(1)}%`);
  {
    let ok = true, detail = [];
    for (const span of [0.072, 0.078, 0.09, 0.096]) {
      const cells = latticeCount(span, 0.006, 4), N = (cells - 1) / 2;
      const voids = N % 2 === 0 ? N * N : (N + 1) * (N + 1);
      const want = (cells * cells - voids) / (cells * cells);
      const got = patchFill(cb, layoutPatches('single', span));
      if (Math.abs(got - want) > 1e-12) ok = false;
      detail.push(`${cells}x${cells}:${(got * 100).toFixed(1)}%`);
    }
    check('finite-array fill follows the rim parity, not the 3/4 of the tile',
      ok, detail.join(' '));
  }
  check('configFill agrees without building a translator',
    Math.abs(configFill(cbCfg) - cbFill) < 1e-12);
  check('a fully-populated array reports full fill',
    configFill({ ...cbCfg, arrayType: 'halbach1d' }) === 1
      && configFill({ ...cbCfg, arrayType: 'alternating' }) === 1);
}

// 72 mm of 6 mm cells is 11.999999999999998 in floating point, and a bare
// Math.floor turned that into 11 -- silently deleting a row AND a column, so
// the renderer drew 121 magnets while the design table billed 144.
console.log('\n=== cell counting survives floating point ===');
// The count is now always ODD, because a symmetric array has to be: an even
// count of a pattern whose cell types repeat every 2 lands opposite parities on
// opposite edges, and that lopsidedness moved the magnet centroid off the platen
// centre on every preset. So 72 mm of 6 mm cells is 11 cells spanning 66 mm --
// one fewer than the lattice could physically hold, which is the price of
// symmetry and is paid whenever the span is an even multiple of the cell.
check('72 mm / 6 mm counts 11 symmetric cells', latticeCount(0.072, 0.006) === 11, `${latticeCount(0.072, 0.006)}`);
// The flip side: an odd count centred on the patch packs BETTER than the old
// even one whenever the span is not an exact multiple, because it no longer
// gives up a half cell at each end. 71 mm of 6 mm cells is 11 cells spanning
// 66 mm, where the old boundary-anchored grid managed only 10 spanning 60 mm.
check('a partial span still fills symmetrically', latticeCount(0.071, 0.006) === 11, `${latticeCount(0.071, 0.006)}`);
check('exact multiples hold at other sizes',
  latticeCount(0.14, 0.01) === 13 && latticeCount(0.04, 0.0035) === 11,
  `${latticeCount(0.14, 0.01)}, ${latticeCount(0.04, 0.0035)}`);
check('counts are always odd, so the array can be symmetric',
  [0.072, 0.071, 0.14, 0.065, 0.04, 0.1, 0.033].every((s) => latticeCount(s, 0.006) % 2 === 1),
  [0.072, 0.071, 0.14, 0.065, 0.04, 0.1, 0.033].map((s) => latticeCount(s, 0.006)).join(','));
check('degenerate cell size does not divide by zero', latticeCount(0.072, 0) === 0);

// The block grid is anchored to the MAGNETISATION lattice, not to the platen
// edge. Anchoring it to the edge puts it half a cell out of phase whenever the
// platen is an odd number of cells wide, and every block then straddles two
// magnetisation cells -- which is not a magnet you can buy, and which made the
// census return a scrambled, non-periodic pattern.
console.log('\n=== the block grid is in phase with the magnetisation ===');
{
  const t = ARRAY_TYPES.halbach2d.build({ pitch: 0.020, thickness: 0.005, Br: 1.32, segments: 4 });
  const pts = layoutPatches('single', 0.065);            // 13 cells of 5 mm: odd
  const seen = [];
  eachCell(t, pts, (px, py, k) => seen.push({ px, py, k }));
  const cw = t.lx / t.nx;
  check('a 13-cell platen holds all 13, symmetrically',
    latticeCount(0.065, cw) === 13, `${latticeCount(0.065, cw)} cells of 5 mm in 65 mm`);
  // Block centres now sit at INTEGER multiples of the cell from the patch
  // centre, not half-integer ones -- that is exactly what makes an odd,
  // symmetric count possible. The blocks are still each centred on one whole
  // magnetisation cell; the pattern is what moved, by the half cell that
  // tr.phase hands to the field evaluator. Checking the old half-integer
  // convention here would now be checking the asymmetry.
  check('every cell centre sits on the symmetric lattice',
    seen.every((c) => Math.abs(((c.px / cw) % 1 + 1.5) % 1 - 0.5) < 1e-9),
    `${seen.length} cells checked`);
  check('the array is centred on the platen',
    Math.abs(seen.reduce((a, c) => a + c.px, 0)) < 1e-12
      && Math.abs(seen.reduce((a, c) => a + c.py, 0)) < 1e-12);
  // Periodicity is the observable consequence: shift by one tile period and the
  // magnetisation must repeat exactly.
  // floor, not round: a cell centre is at an exact half-integer of the cell
  // pitch, and Math.round(-5.5) is -5 while Math.round(5.5) is 6 -- so rounding
  // folds two different cells onto the same key.
  const at = new Map(seen.map((c) => [`${Math.floor(c.px / cw)},${Math.floor(c.py / cw)}`, c.k]));
  let periodic = true;
  for (const [key, k] of at) {
    const [i, j] = key.split(',').map(Number);
    const other = at.get(`${i + t.nx},${j}`);
    if (other !== undefined && other !== k) periodic = false;
  }
  check('magnetisation repeats with the tile period across the platen', periodic);
}

console.log('\n=== grade / gauge lookup ===');
check('Br 1.32 T maps to N42', nearestGrade(1.32).name === 'N42', nearestGrade(1.32).name);
check('Br 1.43 T maps to N52', nearestGrade(1.43).name === 'N52', nearestGrade(1.43).name);
check('0.5 mm wire is AWG 24', nearestAWG(0.0005).gauge === 24, `AWG ${nearestAWG(0.0005).gauge}`);

for (const [key, preset] of Object.entries(PRESETS)) {
  const cfg = JSON.parse(JSON.stringify(preset.cfg));
  const q = Q[cfg.sim.quality];
  console.log(`\n=== ${key} ===`);

  const mech = cfg.mech ?? mechDefaultsFor(cfg, DEFAULT_MECH);
  const stack = stackUp(cfg, mech);
  const tr = makeTranslator({ ...cfg.translator,
    platenMass: cfg.translator.platenMass || stack.platenMass,
    gap: cfg.sim.gap, maxOrder: q.maxOrder });
  const stator = makeStator({ ...cfg.stator, ringsPerCoil: q.ringsPerCoil, segmentsPerSide: q.segmentsPerSide });
  const A = buildAssembly(cfg, stack, tr, stator);

  console.log(`  ${A.census.total} magnets · moving ${(A.movingMass * 1000).toFixed(0)} g · stator ${(A.statorHeight * 1000).toFixed(1)} mm tall`);

  // --- the drawing must quote the mass the physics flew ---------------------
  check('moving mass equals the platen mass used by the dynamics',
    close(A.movingMass, tr.mass, 1e-9), `${(A.movingMass * 1000).toFixed(2)} g vs ${(tr.mass * 1000).toFixed(2)} g`);

  // --- the magnet count must match what gets rendered and what gets bought --
  const census = magnetCensus(tr);
  check('census classes account for every magnet',
    census.axial + census.inPlane + census.diagonal === census.total,
    `${census.axial} axial + ${census.inPlane} in-plane + ${census.diagonal} diagonal = ${census.total}`);
  check('a diagonal magnet is never reported as stock',
    census.diagonal === 0 || (A.sourcing && A.sourcing.remedy),
    census.diagonal ? `${census.diagonal} diagonal, remedy stated` : 'none');
  check('every cell lands in a bin, empties included',
    census.rows.reduce((a, r) => a + r.n, 0) === census.cells,
    `${census.cells} cells, ${census.empty} empty`);
  // Empty pockets are the whole point of the fix: bill them and you order
  // magnets for holes, weigh them and you fly a platen you did not build.
  check('empty pockets are not billed as magnets',
    census.total === census.cells - census.empty);
  // The mass model uses the TILE's fill; the census counts the cells that
  // actually land on the platen, which need not be a whole number of tiles.
  // They must still agree to within a cell or two, or one of them is wrong.
  check('the mass model fills the same fraction of cells the census counts',
    Math.abs(stack.magnetFill - census.total / census.cells) < 0.05,
    `stack fill ${(stack.magnetFill * 100).toFixed(1)}% vs census ${(census.total / census.cells * 100).toFixed(1)}%`);
  check('magnet mass reconciles with the stack-up',
    close(A.parts.find((p) => p.id === 'magnets').mass, stack.magnetMass, 1e-12));

  // --- the concrete order plan, where one exists, must bill the census -------
  // The catalogue turns "through-thickness (stock)" into a part number and a
  // price, so its counts and total have to track the actual array -- otherwise
  // it is just a nicer-looking wrong number.
  if (A.orderPlan) {
    const o = A.orderPlan;
    const qtyByClass = { axial: census.axial, 'in-plane': census.inPlane };
    const lineQtyOk = o.lines.every((l) => l.for === 'both'
      ? l.qty === census.axial + census.inPlane
      : l.qty === qtyByClass[l.for]);
    check(`${key}: order plan counts every magnet from the census`, lineQtyOk,
      o.lines.map((l) => `${l.qty} ${l.for}`).join(', '));
    check(`${key}: order plan bills only stock (no diagonal custom part)`, census.diagonal === 0);
    check(`${key}: order total is the sum of its lines`,
      close(o.total, o.lines.reduce((a, l) => a + l.qty * l.unit, 0), 1e-9),
      `$${o.total.toFixed(2)}`);
    check(`${key}: every ordered magnet has a real supplier URL`,
      o.lines.every((l) => /^https:\/\//.test(l.url)));
    // Cross-check against the number the blurb states independently: the amz316
    // prose was verified from the catalogue long before this order plan existed,
    // so the two agreeing is a real check, not a tautology.
    if (key === 'amz316') check('amz316: order total matches the $47.60 in its blurb',
      close(o.total, 47.60, 1e-9), `$${o.total.toFixed(2)}`);
    if (key === 'pcbmini') check('pcbmini: two Supreme SKUs total $18.06',
      o.skus === 2 && close(o.total, 18.06, 1e-9), `$${o.total.toFixed(2)}`);
  }

  // --- the stack must physically close -------------------------------------
  const solid = A.parts.filter((p) => p.kind !== 'gap' && p.id !== 'retainer');
  solid.sort((a, b) => a.z0 - b.z0);
  let contiguous = true, detail = '';
  for (let i = 1; i < solid.length; i++) {
    const prevTop = solid[i - 1].z0 + solid[i - 1].t;
    if (Math.abs(prevTop - solid[i].z0) > 1e-9) {
      // A void between coil banks is real geometry, not an error: the racetrack
      // stator puts its second bank in a layer below the first.
      if (!(solid[i - 1].id === 'coils' || solid[i].id === 'coils')) {
        contiguous = false;
        detail = `${solid[i - 1].id} top ${prevTop} vs ${solid[i].id} bottom ${solid[i].z0}`;
      }
    }
  }
  check('layers stack contiguously — no floating parts, no interpenetration', contiguous, detail);

  const gapPart = A.parts.find((p) => p.kind === 'gap');
  check('the drawn air gap is the simulated air gap', close(gapPart.t, cfg.sim.gap, 1e-12));
  check('coil top is the air-gap datum (z = 0)',
    close(A.parts.find((p) => p.id === 'coils').z0 + A.parts.find((p) => p.id === 'coils').t, 0, 1e-12));
  check('magnets sit directly above the gap',
    close(A.parts.find((p) => p.id === 'magnets').z0, cfg.sim.gap, 1e-12));
  check('retainer shares the magnet layer',
    close(A.parts.find((p) => p.id === 'retainer').z0, A.parts.find((p) => p.id === 'magnets').z0, 1e-12));

  // --- every part must be orderable ----------------------------------------
  for (const p of A.parts) {
    if (p.kind === 'gap') continue;
    if (!(p.t > 0) || !(p.size > 0) || !isFinite(p.mass) || !p.spec) {
      check(`part "${p.name}" is fully specified`, false, `t=${p.t} size=${p.size} mass=${p.mass}`);
    }
  }
  check('all parts fully specified', true);
}

// --- the prose has to agree with the model too -------------------------------
//
// Every preset blurb states hard numbers, and prose does not recompute itself
// when a config is edited. desk40's blurb claimed "40 magnets in 49 pockets"
// for months after the platen changed under it; the model said 27 in 36. A
// stated-but-stale number is worse than no number, because it reads like a
// result and gets designed around. So parse the claims back out of the blurbs
// and hold them to the model.
//
// Only unambiguous, model-derivable claims are matched. A blurb that phrases
// something differently is simply not checked -- but the count of what WAS
// checked is printed, so silent zero-coverage is visible rather than reassuring.
{
  let claims = 0;
  for (const [key, preset] of Object.entries(PRESETS)) {
    const cfg = JSON.parse(JSON.stringify(preset.cfg));
    const tr = makeTranslator({ ...cfg.translator, ...Q[cfg.sim.quality ?? 'balanced'], gap: cfg.sim.gap });
    const census = magnetCensus(tr);
    const blurb = preset.blurb;

    const inPockets = blurb.match(/(\d[\d,]*) magnets in (\d[\d,]*) pockets/);
    if (inPockets) {
      claims++;
      const n = +inPockets[1].replace(/,/g, ''), m = +inPockets[2].replace(/,/g, '');
      check(`${key}: blurb "${n} magnets in ${m} pockets"`,
        n === census.total && m === census.cells,
        `model says ${census.total} in ${census.cells}`);
    }

    const cubes = blurb.match(/(\d[\d,]*) plain [\d.]+ mm \S+ cubes/);
    if (cubes) {
      claims++;
      const n = +cubes[1].replace(/,/g, '');
      check(`${key}: blurb "${n} cubes"`, n === census.total, `model says ${census.total}`);
    }

    const gapMm = blurb.match(/([\d.]+) mm (?:air )?gap/);
    if (gapMm) {
      claims++;
      check(`${key}: blurb "${gapMm[1]} mm gap"`,
        close(+gapMm[1] / 1000, cfg.sim.gap, 5e-3),
        `config says ${(cfg.sim.gap * 1000).toFixed(2)} mm`);
    }

    const span = blurb.match(/([\d.]+) mm across on a ([\d.]+) mm platen/);
    if (span) {
      claims++;
      // The magnet array spans a whole number of lattice cells, which is not the
      // platen size -- that difference is the symmetry cost, and it is the whole
      // reason this sentence exists.
      const across = arraySymmetry(tr.tile, tr.patches[0]).across[0];
      check(`${key}: blurb "${span[1]} mm array on a ${span[2]} mm platen"`,
        close(+span[1] / 1000, across, 5e-3) && close(+span[2] / 1000, cfg.translator.platenSize, 1e-6),
        `model says ${(across * 1000).toFixed(2)} mm on ${(cfg.translator.platenSize * 1000).toFixed(1)} mm`);
    }

    // "144 coils", "225 hand-wound coils". Deliberately does NOT match the
    // "~120 live coils" phrasing, which counts coils under the array rather than
    // coils on the board -- a different quantity that would fail this check for
    // the right reason and the wrong cause.
    const coils = blurb.match(/(\d[\d,]*)(?: hand-wound)? coils/);
    if (coils) {
      claims++;
      const q = Q[cfg.sim.quality ?? 'balanced'];
      const stator = makeStator({ ...cfg.stator, ringsPerCoil: q.ringsPerCoil, segmentsPerSide: q.segmentsPerSide });
      const n = +coils[1].replace(/,/g, '');
      check(`${key}: blurb "${n} coils"`, n === stator.coils.length,
        `model says ${stator.coils.length}`);
    }

    const lambda = blurb.match(/λ = ([\d.]+) mm/);
    if (lambda) {
      claims++;
      check(`${key}: blurb "λ = ${lambda[1]} mm"`,
        close(+lambda[1] / 1000, tr.cfg.pitch, 5e-3),
        `model says ${(tr.cfg.pitch * 1000).toFixed(2)} mm`);
    }
  }
  // A ratchet, not a target: it fails if the parsers above quietly stop matching
  // (a blurb reworded, a preset renamed), which would otherwise show up as a
  // green run that checks nothing at all.
  check('preset blurbs make checkable claims', claims >= 10, `${claims} numeric claims verified`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall assembly checks pass');
process.exit(fails ? 1 : 0);
