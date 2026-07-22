// The exploded drawing is only worth anything if it cannot disagree with the
// simulation. These checks pin the two together: same masses, same magnet
// count, same air gap, and a stack that actually closes with no gaps or
// interpenetrating parts.

import { makeTranslator, ARRAY_TYPES, layoutPatches, patchFill, configFill, selfTest } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { stackUp, mechDefaultsFor, DEFAULT_MECH } from '../src/mechanical.js';
import { buildAssembly, magnetCensus, nearestGrade, nearestAWG } from '../src/assembly.js';
import { cellsAcross } from '../src/halbach.js';
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
  // 72 mm of 6 mm cells is exactly nine 4x4 tiles, so the platen fill is the
  // tile fill and the expected 3/4 is checkable by hand.
  const cbCfg = { arrayType: 'halbach2d', pitch: 0.024, magnetThickness: 0.003, Br: 1.43,
    segments: 4, layout: 'single', platenSize: 0.072 };
  const cb = ARRAY_TYPES.halbach2d.build({ pitch: 0.024, thickness: 0.003, Br: 1.43, segments: 4 });
  const cbFill = patchFill(cb, layoutPatches('single', 0.072));
  check('the 2-D checkerboard leaves one cell in four empty',
    Math.abs(cbFill - 0.75) < 1e-12, `fill ${(cbFill * 100).toFixed(1)}%`);
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
check('72 mm / 6 mm counts 12 cells, not 11', cellsAcross(0.072, 0.006) === 12, `${cellsAcross(0.072, 0.006)}`);
check('a partial cell is not counted', cellsAcross(0.071, 0.006) === 11, `${cellsAcross(0.071, 0.006)}`);
check('exact multiples hold at other sizes',
  cellsAcross(0.14, 0.01) === 14 && cellsAcross(0.04, 0.0035) === 11,
  `${cellsAcross(0.14, 0.01)}, ${cellsAcross(0.04, 0.0035)}`);
check('degenerate cell size does not divide by zero', cellsAcross(0.072, 0) === 0);

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

console.log(fails ? `\n${fails} FAILURES` : '\nall assembly checks pass');
process.exit(fails ? 1 : 0);
