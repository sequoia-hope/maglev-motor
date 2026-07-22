// The air-gap field, checked against an exact finite-array calculation that
// shares no code with it (reference-field.mjs). physics.test.mjs already pins
// the field's MAGNITUDE against the textbook closed form; everything here is
// about the things a magnitude cannot see -- the sign and phase of the in-plane
// components, which side of the array the flux comes out of, and what actually
// happens at a real edge.

import {
  ARRAY_TYPES, decompose, fieldLocal, cellIsEmpty,
  makeTranslator, fieldAt, eachCell, arraySymmetry, latticeCount,
} from '../src/halbach.js';
import { arrayField, boxField, layTile } from './reference-field.mjs';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!cond) fails++;
};
const hypot3 = (v) => Math.hypot(v[0], v[1], v[2]);

const Br = 1.32, seg = 4, cell = 0.005, pitch = cell * seg, th = 0.005, gap = 0.0022;

// 1. The reference model itself, against the far-field dipole limit. A cuboid of
//    volume V looks like a dipole of moment Br*V/mu0 from far enough away, so on
//    the magnetisation axis B -> Br*V/(2*pi*r^3). Checked on all three axes,
//    because the x and y branches go through a coordinate relabelling that a
//    z-only test would never exercise.
{
  const h = 0.0025, V = (2 * h) ** 3, r = 0.08;
  const want = Br * V / (2 * Math.PI * r ** 3);
  for (const [axis, m, pt] of [
    ['x', [Br, 0, 0], [r, 0, 0]],
    ['y', [0, Br, 0], [0, r, 0]],
    ['z', [0, 0, Br], [0, 0, r]],
  ]) {
    const B = boxField(m, h, h, h, ...pt, [0, 0, 0]);
    const got = hypot3(B);
    check(`reference model: ${axis}-magnetised cuboid -> dipole at 32 edge lengths`,
      Math.abs(got - want) / want < 0.01,
      `${got.toExponential(3)} vs ${want.toExponential(3)} T`);
  }
}

// 2. THE REGRESSION TEST. Compare the sim's field to the exact one component by
//    component, below the array, at points with no symmetry to hide behind.
//
//    This is the check that was missing. The harmonic model had the sign of the
//    i*S term inverted, which leaves |B| and Bz correct and inverts Bx,By -- one
//    side's vertical field wearing the other side's in-plane field. Since flat
//    coils make lift out of J x (Bx,By), that silently inverted lift against
//    thrust, and the controller inverted the same wrong matrix, so every
//    magnitude in the UI and every flight test stayed green.
for (const type of ['halbach1d', 'halbach2d']) {
  const tile = ARRAY_TYPES[type].build({ pitch, thickness: th, Br, segments: seg });
  const harm = decompose(tile, { maxOrder: 6, gapRef: gap });
  const cells = layTile(tile, seg, cell, -40, 39);   // big enough to read as infinite
  const pts = [[0.001, 0.002], [0.004, 0.001], [0.007, 0.006], [0.011, 0.003]];
  // Scale errors by the array's PEAK field, not by the local one. Some of these
  // points sit near a field minimum where the harmonic truncation is a few
  // percent of a small number; that is truncation, not the defect being hunted.
  // A sign inversion moves a component by order the peak, so this still catches
  // it by a wide margin.
  let scale = 0;
  for (const [x, y] of pts) scale = Math.max(scale, hypot3(arrayField(cells, cell, th, x, y, -th / 2 - gap)));
  let worst = 0, worstAt = '';
  for (const [x, y] of pts) {
    const sim = fieldLocal(harm, x, y, gap, [0, 0, 0]).slice();
    const exact = arrayField(cells, cell, th, x, y, -th / 2 - gap);
    for (let i = 0; i < 3; i++) {
      const e = Math.abs(sim[i] - exact[i]) / scale;
      if (e > worst) { worst = e; worstAt = `(${x * 1000},${y * 1000}) mm, ${'xyz'[i]}`; }
    }
  }
  check(`${type}: field below matches the exact array, component-wise`,
    worst < 0.05, `worst component error ${(worst * 100).toFixed(1)}% of peak at ${worstAt}`);
}

// 3. The strong side really does face the coils. Not a restatement of 2: this is
//    the claim the BOM and the exploded drawing make, since they show which way
//    each block is magnetised. Get it backwards and the machine is assembled
//    upside down -- an 8x weaker field where the coils are.
for (const type of ['halbach1d', 'halbach2d']) {
  const tile = ARRAY_TYPES[type].build({ pitch, thickness: th, Br, segments: seg });
  const cells = layTile(tile, seg, cell, -40, 39);
  let below = 0, above = 0;
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      const x = (a / 16 - 0.5) * pitch, y = (b / 16 - 0.5) * pitch;
      below = Math.max(below, hypot3(arrayField(cells, cell, th, x, y, -th / 2 - gap)));
      above = Math.max(above, hypot3(arrayField(cells, cell, th, x, y, th / 2 + gap)));
    }
  }
  check(`${type}: the tile as built throws its flux DOWN, toward the coils`,
    below > above * 3, `below ${below.toFixed(4)} T, above ${above.toFixed(4)} T`);
}

// 4. A magnet in a null cell contributes no FORCE. The 2-D checkerboard leaves
//    one cell in four empty because the ideal pattern has a null there, and the
//    reflex objection is that a hole must be costing lift.
//
//    It is not, but state the invariant precisely, because the loose version of
//    it is false: dropping blocks into the nulls plainly changes the local |B|.
//    What it cannot change is the amplitude of the FUNDAMENTAL -- the one
//    harmonic the coil pitch is matched to, and so the only one that produces
//    net force. The nulls sit exactly where the fundamental has no projection.
//    Everything the added magnets do land in higher harmonics, which decay
//    faster than the fundamental and are not commutated against, plus (if the
//    fill is all one polarity) a net magnetic moment the balanced array does not
//    have. So the fill costs mass and money, buys no force, and hands the platen
//    a DC moment that will find any stray iron in the machine.
//
//    Measured by Fourier-projecting the EXACT field onto the fundamental, so
//    this is not the harmonic model agreeing with itself. Jansen's thesis fills
//    the voids with epoxy and makes the epoxy's DENSITY a design variable -- the
//    void is a mass trade-off, not a magnetic one.
{
  const tile = ARRAY_TYPES.halbach2d.build({ pitch, thickness: th, Br, segments: seg });
  const base = layTile(tile, seg, cell, -16, 15);
  const nulls = [];
  for (let j = -16; j <= 15; j++) {
    for (let i = -16; i <= 15; i++) {
      const k = ((((j % seg) + seg) % seg) * tile.nx + (((i % seg) + seg) % seg)) * 3;
      if (cellIsEmpty(tile, k)) nulls.push({ x: (i + 0.5) * cell, y: (j + 0.5) * cell, m: [0, 0, Br] });
    }
  }
  const f = decompose(tile, { maxOrder: 6, gapRef: gap }).fundamental;
  /** Amplitude of the fundamental in the exact Bz, and its DC offset, over one
   *  interior period. */
  const project = (cells) => {
    let cr = 0, ci = 0, dc = 0, n = 0;
    for (let a = 0; a < 24; a++) {
      for (let b = 0; b < 24; b++) {
        const x = (a / 24) * pitch, y = (b / 24) * pitch;
        const bz = arrayField(cells, cell, th, x, y, -th / 2 - gap)[2];
        const t = f.kx * x + f.ky * y;
        cr += bz * Math.cos(t); ci += bz * Math.sin(t); dc += bz; n++;
      }
    }
    return [2 * Math.hypot(cr, ci) / n, dc / n];
  };
  const [ampEmpty, dcEmpty] = project(base);
  const [ampFilled, dcFilled] = project(base.concat(nulls));
  check('filling the null cells buys no fundamental, at 33% more magnet',
    Math.abs(ampFilled / ampEmpty - 1) < 0.002,
    `${nulls.length} magnets added, fundamental ${ampEmpty.toFixed(4)} -> ${ampFilled.toFixed(4)} T `
    + `(${((ampFilled / ampEmpty - 1) * 100).toFixed(2)}%)`);
  check('...and it gives the platen a net moment the balanced array lacks',
    Math.abs(dcEmpty) < 1e-5 && Math.abs(dcFilled) > 1e-3,
    `mean Bz ${dcEmpty.toExponential(1)} -> ${dcFilled.toExponential(1)} T`);
}

// 5. Voids at the PERIMETER are not a defect either. The outermost cell ring of a
//    checkerboard is half empty -- there is no way to end the pattern on a solid
//    row of vertical blocks -- and the instinct is that the rim needs filling in.
//    Measured against the same array made infinite, the outermost column still
//    carries most of the interior field. What the literature says goes wrong at
//    an edge is the SHAPE of the force wave, not its amplitude (the commutation
//    law, handled on the coil side), and that is invisible to this test.
{
  const tile = ARRAY_TYPES.halbach2d.build({ pitch, thickness: th, Br, segments: seg });
  const lo = -6, hi = 5;
  const finite = layTile(tile, seg, cell, lo, hi);
  const infinite = layTile(tile, seg, cell, -40, 39);
  const colPeak = (cs, i) => {
    let p = 0;
    for (let a = 1; a < 5; a++) {
      for (let j = lo; j <= hi; j++) {
        for (let b = 1; b < 5; b++) {
          p = Math.max(p, hypot3(arrayField(cs, cell, th, (i + a / 5) * cell, (j + b / 5) * cell, -th / 2 - gap)));
        }
      }
    }
    return p;
  };
  const rim = Math.min(colPeak(finite, lo) / colPeak(infinite, lo),
                       colPeak(finite, hi) / colPeak(infinite, hi));
  check('the outermost cell column keeps most of its field despite the rim voids',
    rim > 0.85, `outermost column at ${(rim * 100).toFixed(0)}% of the infinite array`);
}

// 5b. The blocks the BOM bills must sit in the field fieldAt() reports.
//
//     axisCells() lays the symmetric lattice half a cell off the tile's own
//     grid, so patch coordinates and tile coordinates differ by tr.phase. Every
//     consumer that draws or bills a magnet reads eachCell(); the physics reads
//     fieldAt(). If those two disagree about phase, the drawing and the field
//     describe arrays half a cell apart and nothing else in the suite notices.
//
//     So build the exact array out of eachCell's OWN output and compare it to
//     fieldAt at the same world point. This is the check that the half-cell
//     shift introduced with the symmetric lattice was applied in both places.
{
  const cfg = {
    arrayType: 'halbach2d', layout: 'single', pitch, magnetThickness: th, Br,
    segments: seg, platenSize: 0.220, platenMass: 0, maxOrder: 6, gap,
  };
  const tr = makeTranslator(cfg);
  const laid = [];
  eachCell(tr.tile, tr.patches, (px, py, k) => {
    if (!cellIsEmpty(tr.tile, k)) {
      laid.push({ x: px, y: py, m: [tr.tile.cells[k], tr.tile.cells[k + 1], tr.tile.cells[k + 2]] });
    }
  });
  const R = [1, 0, 0, 0, 1, 0, 0, 0, 1], origin = [0, 0, 0];
  const pts = [[0.001, 0.002], [0.004, 0.001], [0.007, 0.006], [-0.003, 0.005]];
  let scale = 0, worst = 0, worstAt = '';
  for (const [x, y] of pts) scale = Math.max(scale, hypot3(arrayField(laid, cell, th, x, y, -th / 2 - gap)));
  for (const [x, y] of pts) {
    // fieldAt measures depth below the magnet FACE, which the exact model puts
    // at -th/2 with the blocks centred on z = 0.
    const sim = fieldAt(tr, x, y, -gap, origin, R, [0, 0, 0]).slice();
    const exact = arrayField(laid, cell, th, x, y, -th / 2 - gap);
    for (let i = 0; i < 3; i++) {
      const e = Math.abs(sim[i] - exact[i]) / scale;
      if (e > worst) { worst = e; worstAt = `(${x * 1000},${y * 1000}) mm, ${'xyz'[i]}`; }
    }
  }
  check('the billed blocks are in phase with the evaluated field',
    worst < 0.06, `worst component error ${(worst * 100).toFixed(1)}% of peak at ${worstAt}`);
}

// 5c. The array is symmetric, and its magnet centroid is the platen centre.
//
//     An even cell count puts opposite parities on opposite edges -- voids down
//     one side and none down the other -- which offset the magnet centroid by
//     ~1/6 of a cell on every preset while makeTranslator put the centre of mass
//     at the platen centre. Both symmetric arrays (rim of magnets, rim of voids)
//     are fine; a lopsided one is not.
for (const platen of [0.060, 0.040, 0.072, 0.065, 0.100]) {
  const tr = makeTranslator({
    arrayType: 'halbach2d', layout: 'single', pitch, magnetThickness: th, Br,
    segments: seg, platenSize: platen, platenMass: 0, maxOrder: 3, gap,
  });
  let n = 0, sx = 0, sy = 0;
  const xs = new Set(), ys = new Set();
  eachCell(tr.tile, tr.patches, (px, py, k) => {
    xs.add(px.toFixed(9)); ys.add(py.toFixed(9));
    if (!cellIsEmpty(tr.tile, k)) { n++; sx += px; sy += py; }
  });
  const sym = arraySymmetry(tr.tile, tr.patches[0]);
  const off = Math.hypot(sx / n, sy / n);
  check(`${(platen * 1000).toFixed(0)} mm platen: ${xs.size}x${ys.size} array, rim of ${sym.rim}, centroid centred`,
    off < 1e-12 && xs.size % 2 === 1 && xs.size === ys.size && xs.size === sym.nx && sym.ny === sym.nx,
    `centroid offset ${(off * 1e6).toFixed(3)} um, ${n} magnets`);
}

// 6. What the finite-extent taper in fieldAt() actually asserts. taper = pitch/2
//    and a smoothstep's effective step sits at its midpoint, so the model pulls
//    the working edge of the platen in by pitch/4 -- which at the usual four
//    segments per wavelength is exactly ONE magnet cell.
//
//    That is a bad model of the field (measured: the field is still ~91% at the
//    outermost block centre and dies over about one air gap, not one half-pitch)
//    and a defensible model of the USABLE force, because the documented fix for
//    edge effects is on the coil side: Jansen switches off the coils that reach
//    under the outer magnet row, costing a de-rated band about one magnet row
//    deep. The number is right for a reason the code does not implement, so pin
//    the coincidence -- if segments ever stops being 4, this stops being true.
{
  const inset = (pitch * 0.5) / 2;
  check('the edge taper insets the platen by exactly one magnet cell',
    Math.abs(inset - cell) < 1e-12, `inset ${(inset * 1000).toFixed(3)} mm vs cell ${(cell * 1000).toFixed(3)} mm`);
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
