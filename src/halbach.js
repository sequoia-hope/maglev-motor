// Magnet-array modelling: build a magnetisation tile, decompose it into spatial
// harmonics, and evaluate the air-gap field analytically.
//
// THEORY (this is the Jansen / Kim "harmonic model"):
//   The translator's magnetisation is periodic in x and y with periods
//   lx, ly. Expand it as a Fourier series with in-plane wavevectors
//   kx = 2*pi*m/lx, ky = 2*pi*n/ly, k = |k|. In the air gap below a slab of
//   thickness D the scalar potential of each harmonic decays as exp(-k*d),
//   so the field below the magnet face is
//
//     Bz_hat = 0.5*(1 - exp(-k*D)) * [ Mz_hat - i*(kx*Mx_hat + ky*My_hat)/k ]
//     Bx_hat = i*(kx/k)*Bz_hat        By_hat = i*(ky/k)*Bz_hat
//
//   with the magnetisation expressed in tesla (i.e. mu0*M, so |m| = Br).
//   The bracket vanishes for the "wrong-handed" harmonic -- that is exactly the
//   Halbach one-sided-flux condition, and it falls out of the model rather than
//   being assumed. selfTest() below checks the fundamental against the textbook
//   closed form Br*(1-exp(-k*D))*sin(pi/M)/(pi/M).
//
// The transverse decay exp(-k*d) is the single most important fact in the whole
// design space: doubling the pole pitch doubles the usable air gap.

import { smoothstep } from './math.js';

const TWO_PI = Math.PI * 2;

const sinc = (x) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x);

// --- tile builders ----------------------------------------------------------
// A tile is one spatial period of magnetisation, sampled on an nx*ny grid of
// cells. Each cell holds a magnetisation vector in tesla. Real arrays are built
// from discrete cuboid magnets of fixed Br, so we sample the ideal continuous
// pattern at one point per cell and renormalise each cell to |m| = Br. That
// renormalisation is what generates the real harmonic distortion of a discrete
// array (and the classic sin(pi/M)/(pi/M) amplitude penalty).
//
// WHERE inside the cell we sample is a real design decision, not an
// implementation detail, because it decides what you can buy. Sampling at the
// cell CENTRE (origin = 0.5) puts a 4-segment array's blocks half a cell off
// the pattern's own axes, so every one of them comes out on a body diagonal --
// a custom magnetisation at several times the price of stock. Sampling at the
// cell EDGE (origin = 0) is the same array translated by half a cell: identical
// physics, but every block lands on an axis and becomes a catalogue part.
// Each array type therefore declares the origin that makes it buildable.

function makeTile({ nx, ny, lx, ly, thickness, Br, fn, normalize = true, origin = 0.5 }) {
  const cells = new Float64Array(nx * ny * 3);
  for (let q = 0; q < ny; q++) {
    for (let p = 0; p < nx; p++) {
      const x = ((p + origin) / nx) * lx;
      const y = ((q + origin) / ny) * ly;
      let m = fn(x, y, lx, ly);
      if (normalize) {
        const L = Math.hypot(m[0], m[1], m[2]);
        m = L > 1e-9 ? [m[0] / L, m[1] / L, m[2] / L] : [0, 0, 0];
      }
      const i = (q * nx + p) * 3;
      cells[i] = m[0] * Br;
      cells[i + 1] = m[1] * Br;
      cells[i + 2] = m[2] * Br;
    }
  }
  const tile = { nx, ny, lx, ly, thickness, Br, cells };
  orientStrongSideDown(tile);
  return tile;
}

/** Raw Fourier coefficients of the magnetisation, half-plane only. */
function magHarmonics(tile, maxOrder) {
  const { nx, ny, lx, ly, cells } = tile;
  const oneD = ny === 1;
  const mMax = Math.min(maxOrder, Math.floor(nx / 2));
  const nMax = oneD ? 0 : Math.min(maxOrder, Math.floor(ny / 2));
  const out = [];
  for (let m = 0; m <= mMax; m++) {
    for (let n = -nMax; n <= nMax; n++) {
      if (m === 0 && n <= 0) continue;
      const kx = (TWO_PI * m) / lx;
      const ky = (TWO_PI * n) / ly;
      const k = Math.hypot(kx, ky);
      if (k < 1e-9) continue;
      let mxr = 0, mxi = 0, myr = 0, myi = 0, mzr = 0, mzi = 0;
      for (let q = 0; q < ny; q++) {
        const y = ((q + 0.5) / ny) * ly;
        for (let p = 0; p < nx; p++) {
          const x = ((p + 0.5) / nx) * lx;
          const th = -(kx * x + ky * y);
          const c = Math.cos(th), s = Math.sin(th);
          const i = (q * nx + p) * 3;
          mxr += cells[i] * c; mxi += cells[i] * s;
          myr += cells[i + 1] * c; myi += cells[i + 1] * s;
          mzr += cells[i + 2] * c; mzi += cells[i + 2] * s;
        }
      }
      // Exact coefficient of the piecewise-constant cell pattern: the DFT of
      // the samples times the sinc of the cell footprint. That sinc is what
      // produces the classic sin(pi/M)/(pi/M) Halbach amplitude penalty.
      const norm = (1 / (nx * ny)) * sinc((Math.PI * m) / nx) * (oneD ? 1 : sinc((Math.PI * n) / ny));
      out.push({
        kx, ky, k,
        mxr: mxr * norm, mxi: mxi * norm,
        myr: myr * norm, myi: myi * norm,
        mzr: mzr * norm, mzi: mzi * norm,
      });
    }
  }
  return out;
}

/** A Halbach array is one-sided, so it matters which way up it is. Rather than
 *  hand-checking the sign convention of every pattern, measure which side the
 *  flux actually comes out of and flip the in-plane magnets if it is the wrong
 *  one. Negating the in-plane components is exactly what physically rotating
 *  the array 180 degrees about z does. */
function orientStrongSideDown(tile) {
  const hs = magHarmonics(tile, 3);
  let below = 0, above = 0;
  for (const h of hs) {
    const g = 0.5 * (1 - Math.exp(-h.k * tile.thickness)) * Math.exp(-h.k * tile.thickness);
    const Sr = (h.kx * h.mxr + h.ky * h.myr) / h.k;
    const Si = (h.kx * h.mxi + h.ky * h.myi) / h.k;
    below += (g * (h.mzr + Si)) ** 2 + (g * (h.mzi - Sr)) ** 2;
    above += (g * (h.mzr - Si)) ** 2 + (g * (h.mzi + Sr)) ** 2;
  }
  if (above > below) {
    for (let i = 0; i < tile.cells.length; i += 3) {
      tile.cells[i] *= -1;
      tile.cells[i + 1] *= -1;
    }
  }
}

// Insertion order is the order of the topology dropdown, and the first entry is
// what an unset config falls back to -- so the checkerboard leads. It is the only
// topology that closes x, y and lift from a single array out of nothing but
// stock magnets, which makes it the right thing to land on before you have
// decided anything else.
export const ARRAY_TYPES = {
  // 2-D checkerboard Halbach (Jansen). Vertical magnets on a checkerboard with
  // horizontal "flux-steering" magnets between them.
  halbach2d: {
    label: '2-D Halbach (checkerboard)',
    note: 'Jansen / Beckhoff XPlanar style. Gives x and y thrust plus lift from a single array. One cell in four is a null in the ideal pattern and is left EMPTY — that is the real array, and the missing quarter of the magnet volume is why it lifts less than a fully-populated tile would suggest.',
    build: ({ pitch, thickness, Br, segments }) =>
      makeTile({
        nx: segments, ny: segments, lx: pitch, ly: pitch, thickness, Br,
        origin: 0,
        fn: (x, y, lx, ly) => {
          const kx = TWO_PI / lx, ky = TWO_PI / ly;
          const r = 1 / Math.SQRT2;
          return [
            r * Math.sin(kx * x) * Math.cos(ky * y),
            r * Math.cos(kx * x) * Math.sin(ky * y),
            Math.cos(kx * x) * Math.cos(ky * y),
          ];
        },
      }),
  },

  // Classic 1D Halbach (Kim & Trumper). segments = magnets per wavelength.
  // Strong side faces -z, toward the coils.
  halbach1d: {
    label: '1-D Halbach',
    note: 'Kim/Trumper. Simplest to build from stock cube magnets. Gives lift + one thrust axis per array, so you need at least two orientations.',
    build: ({ pitch, thickness, Br, segments }) =>
      makeTile({
        nx: segments, ny: 1, lx: pitch, ly: pitch, thickness, Br,
        origin: 0,
        fn: (x, _y, lx) => {
          const k = TWO_PI / lx;
          // Handedness chosen so the strong side is -z.
          return [-Math.sin(k * x), 0, Math.cos(k * x)];
        },
      }),
  },

  // The same checkerboard rotated 45 deg in the platen plane. Its effective
  // pole pitch is pitch/sqrt(2), so it trades usable air gap for a finer field
  // -- worth comparing directly rather than taking on faith.
  halbach2dDiag: {
    label: '2-D Halbach (45-deg diagonal)',
    note: 'Checkerboard rotated 45 deg. Effective pole pitch drops by sqrt(2), so the field is finer but decays faster with gap. Compare lift-vs-gap against the checkerboard.',
    build: ({ pitch, thickness, Br, segments }) =>
      makeTile({
        // No sampling origin makes this one buildable from stock: the pattern's
        // axes are at 45 deg to the cells, so half the blocks are diagonal
        // whichever way the tile is shifted (checked both -- an edge origin
        // trades the same 32 diagonals for 8 empty cells and 4% less field).
        // Centre sampling is kept because it is the stronger of the two.
        nx: segments * 2, ny: segments * 2, lx: pitch, ly: pitch, thickness, Br,
        fn: (x, y, lx) => {
          const s = Math.SQRT1_2;
          const u = (x + y) * s, w = (-x + y) * s;
          const ku = TWO_PI / (lx * s);
          const r = 1 / Math.SQRT2;
          const mu = r * Math.sin(ku * u) * Math.cos(ku * w);
          const mw = r * Math.cos(ku * u) * Math.sin(ku * w);
          const mz = Math.cos(ku * u) * Math.cos(ku * w);
          return [mu * s - mw * s, mu * s + mw * s, mz];
        },
      }),
  },

  // No flux steering: plain alternating N/S poles. Included as the baseline so
  // you can see exactly what the Halbach geometry buys you.
  alternating: {
    label: 'Plain N/S (no Halbach)',
    note: 'Baseline for comparison. Half the one-sided flux, and it leaks upward into whatever the platen carries.',
    build: ({ pitch, thickness, Br, segments }) =>
      makeTile({
        nx: Math.max(2, segments), ny: Math.max(2, segments), lx: pitch, ly: pitch, thickness, Br,
        normalize: false,
        fn: (x, y, lx, ly) => [
          0, 0,
          Math.sign(Math.cos((TWO_PI / lx) * x) * Math.cos((TWO_PI / ly) * y)) || 1,
        ],
      }),
  },
};

// --- driving the design from the magnet you can actually buy -----------------
//
// Normally the pole pitch is the free variable and the cell size falls out of it
// as pitch/segments. That is the right order for exploring physics and the wrong
// order for building anything: the optimiser happily returns a 20.9 mm pitch in
// four segments, i.e. 5.225 mm cells, and nobody stocks a 5.225 mm magnet. Every
// block becomes a custom grind, which costs more than the rest of the machine.
//
// Driving it the other way makes the magnet the input and the pitch the
// consequence: pick a size off a supplier's shelf, pick how many magnets make a
// wavelength, and the pole pitch is whatever those two say it is. The pitch then
// moves in steps, not continuously -- which is a real and unavoidable property
// of building from stock parts, not a limitation of the model.

/** Block edge lengths every NdFeB supplier stocks, in metres. Cubes in these
 *  sizes are catalogue items; anything between them is a custom order. */
export const STOCK_MAGNET_SIZES = [
  0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.010, 0.012, 0.015, 0.020, 0.025,
];

/** Snap to the nearest stocked size. */
export function nearestStockMagnet(size) {
  let best = STOCK_MAGNET_SIZES[0];
  for (const s of STOCK_MAGNET_SIZES) if (Math.abs(s - size) < Math.abs(best - size)) best = s;
  return best;
}

/** Enforce the magnet-driven relationship on a translator config, in place.
 *
 *  Call this on any config before anything reads pitch or thickness -- the whole
 *  point is that when `driveByMagnet` is set there is no independent pole pitch
 *  to read, only a derived one, and a config where the two disagree describes a
 *  machine that cannot be assembled. Also backfills `magnetSize` for configs
 *  written before this existed, so the field is always meaningful. */
export function applyMagnetDrive(t) {
  if (!(t.magnetSize > 0)) t.magnetSize = t.pitch / Math.max(t.segments, 1);
  if (!t.driveByMagnet) return t;
  t.segments = Math.max(2, Math.round(t.segments));
  t.pitch = t.magnetSize * t.segments;
  // Cube stock is the cheap case: one part number, and thickness is not a
  // separate thing you can choose.
  if (t.cubicMagnets) t.magnetThickness = t.magnetSize;
  return t;
}

// --- where the magnets physically sit ---------------------------------------

/** The magnet patches for a layout. Extracted so the mass model, the BOM and
 *  the drawing all place magnets on the same grid rather than each deciding
 *  for itself. */
export function layoutPatches(layout, platenSize) {
  const patches = [];
  if (layout === 'single') {
    patches.push({ u: 0, v: 0, w: platenSize, h: platenSize, theta: 0 });
  } else if (layout === 'quad') {
    // Kim / Teo four-array cross. Each array thrusts TANGENTIALLY -- the arrays
    // on the x axis push along y, and vice versa. This is not cosmetic: an array
    // at position r pushing along r contributes r x F = 0, so a radial layout
    // has no yaw authority whatsoever. Tangential thrust makes differential
    // force between opposite arms produce Tz, which is how this topology closes
    // all six degrees of freedom.
    const arm = platenSize * 0.42;
    const r = platenSize * 0.27;
    patches.push({ u: -r, v: 0, w: arm, h: arm, theta: Math.PI / 2 });
    patches.push({ u: r, v: 0, w: arm, h: arm, theta: Math.PI / 2 });
    patches.push({ u: 0, v: -r, w: arm, h: arm, theta: 0 });
    patches.push({ u: 0, v: r, w: arm, h: arm, theta: 0 });
  }
  for (const p of patches) {
    p.cos = Math.cos(p.theta);
    p.sin = Math.sin(p.theta);
  }
  return patches;
}

/** Cell indices of the tile lattice that fit wholly inside a patch of width
 *  `span`, as [first, last] inclusive.
 *
 *  The epsilon is not decoration. 72 mm of 6 mm cells evaluates to
 *  11.999999999999998, so a bare floor drops an entire row AND column -- 144
 *  magnets drawn and billed as 121, a 16% undercount that once showed up as the
 *  renderer and the design table disagreeing with each other.
 *
 *  The lattice is NOT free to start at the patch edge. Magnetisation is
 *  piecewise-constant on cell boundaries at multiples of `cell` measured from
 *  the patch centre -- that is where the harmonic model puts them, and the field
 *  evaluator reads it there. A block laid out from the patch edge instead lands
 *  half a cell out of phase whenever the patch is an odd number of cells wide,
 *  so it straddles two magnetisation cells: not one magnet, and not buildable.
 *  Anchoring here instead costs up to one cell of unused border, which is real
 *  -- a platen is only as big as a whole number of magnets. */
function latticeRange(span, cell) {
  if (!(cell > 0) || !(span > 0)) return [0, -1];
  const half = span / 2;
  const eps = 1e-6;
  return [Math.ceil(-half / cell - eps), Math.floor(half / cell + eps) - 1];
}

/** The cells of one axis: where each sits in patch coordinates, and which tile
 *  cell it takes its magnetisation from.
 *
 *  Only an axis the magnetisation actually varies along is quantised. A 1-D
 *  Halbach tile is one cell tall -- its blocks are bars, uniform along y -- so
 *  there is no phase to get wrong and no reason to give up a strip of platen to
 *  a lattice that carries no information. Quantising it anyway is how the
 *  four-array cross ended up reporting zero magnets: a 58.8 mm arm could not fit
 *  a 40 mm bar centred on a lattice it did not need to obey. */
function axisCells(span, cell, n) {
  const out = [];
  if (!(cell > 0) || !(span > 0)) return out;
  if (n === 1) {
    // Free axis: pack whole cells and centre them on the patch.
    const m = Math.floor(span / cell + 1e-6);
    for (let j = 0; j < m; j++) out.push({ c: -span / 2 + (j + 0.5) * cell, i: 0 });
    return out;
  }
  const [a, b] = latticeRange(span, cell);
  for (let i = a; i <= b; i++) out.push({ c: (i + 0.5) * cell, i: ((i % n) + n) % n });
  return out;
}

/** How many whole tile cells fit across a patch of width `span`. `n` is the
 *  number of tile cells on that axis; pass 1 for an axis with no periodicity. */
export function latticeCount(span, cell, n = 2) {
  return axisCells(span, cell, n).length;
}

/** Visit every cell of every patch, in patch-local coordinates.
 *
 *  One walk, used by the mass model, the BOM and both renderers, because the
 *  last time these each had their own copy the drawing showed 121 magnets while
 *  the table billed 144. `fn(px, py, k, patch)` gets the cell centre in patch
 *  coordinates and the offset `k` of its magnetisation in tile.cells. */
export function eachCell(tile, patches, fn) {
  const cellW = tile.lx / tile.nx, cellH = tile.ly / tile.ny;
  for (const pt of patches) {
    // Cell i spans [i*cell, (i+1)*cell), so its magnetisation is tile cell
    // i mod n -- an exact integer operation, with no chance for a cell boundary
    // to be decided by floating-point noise.
    const us = axisCells(pt.w, cellW, tile.nx);
    const vs = axisCells(pt.h, cellH, tile.ny);
    for (const v of vs) {
      for (const u of us) fn(u.c, v.c, (v.i * tile.nx + u.i) * 3, pt);
    }
  }
}

/** True if a cell holds no magnet at all.
 *
 *  Where the ideal pattern has a null there is no defensible magnetisation
 *  direction, so the cell is left empty -- those are the holes you see in every
 *  published 2-D Halbach array. They are not bought, not weighed and not drawn,
 *  so everything that bills, weighs or draws the magnet layer asks here rather
 *  than assuming a solid slab. */
export function cellIsEmpty(tile, k) {
  return Math.hypot(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2]) <= 1e-9 * tile.Br;
}

/** True if every block in the tile is magnetised along one of its own axes.
 *
 *  Buying a stock SIZE is only half of buying a stock magnet. A supplier's
 *  catalogue block is magnetised through its thickness or through its length; a
 *  block magnetised at 51 degrees is a custom order whatever its dimensions.
 *  That distinction is what decides whether "5 mm cubes" means a bag of cubes or
 *  a bespoke magnetising fixture, and it depends on the segment count: only
 *  M = 2 and M = 4 put the ideal rotating magnetisation on axes at every sample,
 *  because only then are the angles multiples of 90 degrees. */
export function tileIsStockMagnetised(tile, tolDeg = 10) {
  const n = tile.nx * tile.ny;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    const L = Math.hypot(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2]);
    if (L <= 1e-9 * tile.Br) continue;             // empty pocket: nothing to buy
    const elev = Math.abs((Math.asin(tile.cells[k + 2] / L) * 180) / Math.PI);
    if (elev > tolDeg && elev < 90 - tolDeg) return false;
  }
  return true;
}

/** Fraction of the platen's cells that actually hold a magnet. Counted over the
 *  patches as they are really tiled, not over one period -- a platen is rarely a
 *  whole number of tiles, and rounding it to one puts the mass model and the BOM
 *  several percent apart. */
export function patchFill(tile, patches) {
  let n = 0, filled = 0;
  eachCell(tile, patches, (_px, _py, k) => { n++; if (!cellIsEmpty(tile, k)) filled++; });
  return n ? filled / n : 1;
}

// stackUp() needs the fill fraction before a translator exists, and the
// optimiser calls it once per candidate, so the answer is cached on the config
// fields the pattern and the tiling actually depend on.
const _fillCache = new Map();

/** Fill fraction for a translator config, without building a translator. */
export function configFill({ arrayType, pitch, magnetThickness, Br, segments, layout, platenSize }) {
  const key = `${arrayType}|${pitch}|${segments}|${layout}|${platenSize}`;
  if (_fillCache.has(key)) return _fillCache.get(key);
  const type = ARRAY_TYPES[arrayType];
  let f = 1;
  if (type) {
    const tile = type.build({ pitch, thickness: magnetThickness, Br, segments });
    f = patchFill(tile, layoutPatches(layout, platenSize));
  }
  _fillCache.set(key, f);
  return f;
}

// --- harmonic decomposition -------------------------------------------------

/** Fourier-decompose a tile. Keeps the half-plane of harmonics (m>0, or m==0
 *  and n>0) since the field is real; each retained term is doubled on
 *  evaluation. Terms whose amplitude is negligible at the working gap are
 *  dropped, which is what keeps the field evaluation cheap enough to run inside
 *  the control loop. */
export function decompose(tile, { maxOrder = 3, gapRef = 0.002, tol = 1e-4 } = {}) {
  const { thickness } = tile;
  const terms = [];
  let peak = 0;
  for (const h of magHarmonics(tile, maxOrder)) {
    // S = (kx*Mx_hat + ky*My_hat)/k  ;  bracket for the field BELOW is
    // Mz_hat - i*S, which vanishes for the wrong-handed harmonic.
    const Sr = (h.kx * h.mxr + h.ky * h.myr) / h.k;
    const Si = (h.kx * h.mxi + h.ky * h.myi) / h.k;
    const g = 0.5 * (1 - Math.exp(-h.k * thickness));
    const cr = g * (h.mzr + Si);
    const ci = g * (h.mzi - Sr);
    const amp = Math.hypot(cr, ci) * Math.exp(-h.k * gapRef);
    peak = Math.max(peak, amp);
    terms.push({ kx: h.kx, ky: h.ky, k: h.k, cr, ci, amp });
  }
  const kept = terms.filter((t) => t.amp > tol * peak).sort((a, b) => b.amp - a.amp);

  // Flatten to typed arrays: the field evaluator is the hottest loop in the sim.
  const N = kept.length;
  const out = {
    n: N,
    kx: new Float64Array(N), ky: new Float64Array(N), k: new Float64Array(N),
    // Pre-multiplied component coefficients so evaluation is pure multiply-add.
    zr: new Float64Array(N), zi: new Float64Array(N),
    xr: new Float64Array(N), xi: new Float64Array(N),
    yr: new Float64Array(N), yi: new Float64Array(N),
    tile,
    fundamental: kept.length ? kept[0] : null,
  };
  kept.forEach((t, i) => {
    out.kx[i] = t.kx; out.ky[i] = t.ky; out.k[i] = t.k;
    out.zr[i] = t.cr; out.zi[i] = t.ci;
    // Bx_hat = i*(kx/k)*Bz_hat  ->  (re,im) = (kx/k)*(-ci, cr)
    out.xr[i] = (t.kx / t.k) * -t.ci; out.xi[i] = (t.kx / t.k) * t.cr;
    out.yr[i] = (t.ky / t.k) * -t.ci; out.yi[i] = (t.ky / t.k) * t.cr;
  });
  return out;
}

/** Peak Bz at depth d below the magnet face, from the fundamental only. */
export function peakField(harm, d) {
  if (!harm.fundamental) return 0;
  const f = harm.fundamental;
  return 2 * Math.hypot(f.cr, f.ci) * Math.exp(-f.k * d);
}

// Successive filaments of a coil sit at the same height, so the exp(-k*d)
// factors repeat. Caching them turns the hot loop from three transcendentals
// per harmonic into two.
let _expHarm = null, _expD = NaN, _expArr = null;

/** Field in the tile's own frame. d is depth BELOW the magnet face, positive.
 *  Writes into out=[bx,by,bz]. */
export function fieldLocal(harm, x, y, d, out) {
  if (harm !== _expHarm || d !== _expD) {
    if (harm !== _expHarm || !_expArr || _expArr.length < harm.n) {
      _expArr = new Float64Array(harm.n);
    }
    for (let i = 0; i < harm.n; i++) _expArr[i] = 2 * Math.exp(-harm.k[i] * d);
    _expHarm = harm; _expD = d;
  }
  const E = _expArr;
  let bx = 0, by = 0, bz = 0;
  for (let i = 0; i < harm.n; i++) {
    const th = harm.kx[i] * x + harm.ky[i] * y;
    const c = Math.cos(th), s = Math.sin(th);
    const e = E[i];
    bx += e * (harm.xr[i] * c - harm.xi[i] * s);
    by += e * (harm.yr[i] * c - harm.yi[i] * s);
    bz += e * (harm.zr[i] * c - harm.zi[i] * s);
  }
  out[0] = bx; out[1] = by; out[2] = bz;
  return out;
}

// --- translator: a rigid platen carrying one or more magnet patches ----------

/** A patch is a finite window of a periodic tile, placed and rotated on the
 *  platen. Finite extent is handled with a smooth taper one half-pitch wide at
 *  each edge -- an approximation (a truly finite array needs a surface-charge
 *  model), but it keeps edge behaviour qualitatively right at real-time cost.
 *  Errors are largest within about one pitch of an array edge. */
export function makeTranslator(cfg) {
  const {
    arrayType, pitch, magnetThickness, Br, segments,
    layout, platenSize, platenMass, maxOrder, gap,
  } = cfg;

  const tile = ARRAY_TYPES[arrayType].build({
    pitch, thickness: magnetThickness, Br, segments,
  });
  const harm = decompose(tile, { maxOrder, gapRef: gap });

  const patches = layoutPatches(layout, platenSize);

  // Magnet mass: NdFeB ~7500 kg/m^3, plus the platen structure. Only the
  // populated cells count -- an array with empty cells is lighter, and pretending
  // otherwise flies a platen heavier than the one you would build.
  const magArea = patches.reduce((a, p) => a + p.w * p.h, 0);
  const fill = patchFill(tile, patches);
  const magnetMass = magArea * magnetThickness * 7500 * fill;
  const mass = platenMass > 0 ? platenMass : magnetMass * 1.6;

  // Box inertia about the platen centre.
  const a = platenSize, b = platenSize, c = magnetThickness * 3;
  const inertia = [
    (mass / 12) * (b * b + c * c),
    (mass / 12) * (a * a + c * c),
    (mass / 12) * (a * a + b * b),
  ];

  return {
    cfg, tile, harm, patches, mass, inertia, magnetMass, fill,
    stockMagnetised: tileIsStockMagnetised(tile),
    faceZ: 0, // magnet face is the platen origin plane; +z is up, away from coils
    footprintRadius: Math.max(...patches.map((p) =>
      Math.hypot(Math.abs(p.u) + p.w / 2, Math.abs(p.v) + p.h / 2))),
    peakGapField: peakField(harm, gap),
  };
}

const _tmpB = new Float64Array(3);

/** World-frame field at point (px,py,pz), produced by the translator whose
 *  centre of mass is at r with body->world rotation matrix R (row-major).
 *  Allocation-free: this runs once per coil filament per control step. */
export function fieldAt(tr, px, py, pz, r, R, out) {
  // World -> body
  const ex = px - r[0], ey = py - r[1], ez = pz - r[2];
  const bx0 = R[0] * ex + R[3] * ey + R[6] * ez;
  const by0 = R[1] * ex + R[4] * ey + R[7] * ez;
  const bz0 = R[2] * ex + R[5] * ey + R[8] * ez;

  const d = tr.faceZ - bz0; // depth below the magnet face
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (d <= 1e-6) return out; // above the magnets: outside the model's validity

  const taper = tr.cfg.pitch * 0.5;
  let ax = 0, ay = 0, az = 0;

  for (let i = 0; i < tr.patches.length; i++) {
    const pt = tr.patches[i];
    const dx = bx0 - pt.u, dy = by0 - pt.v;
    const ct = pt.cos, st = pt.sin; // rotation by -theta
    const qx = dx * ct + dy * st;
    const qy = -dx * st + dy * ct;

    const hw = pt.w / 2, hh = pt.h / 2;
    const wx = smoothstep(-hw, -hw + taper, qx) * (1 - smoothstep(hw - taper, hw, qx));
    if (wx < 1e-4) continue;
    const wy = smoothstep(-hh, -hh + taper, qy) * (1 - smoothstep(hh - taper, hh, qy));
    const win = wx * wy;
    if (win < 1e-4) continue;

    fieldLocal(tr.harm, qx, qy, d, _tmpB);
    // Patch -> body: rotate back by +theta
    ax += win * (_tmpB[0] * ct - _tmpB[1] * st);
    ay += win * (_tmpB[0] * st + _tmpB[1] * ct);
    az += win * _tmpB[2];
  }
  // Body -> world
  out[0] = R[0] * ax + R[1] * ay + R[2] * az;
  out[1] = R[3] * ax + R[4] * ay + R[5] * az;
  out[2] = R[6] * ax + R[7] * ay + R[8] * az;
  return out;
}

// --- model self-check -------------------------------------------------------

/** Compare the harmonic model's fundamental against the closed-form Halbach
 *  result Br*(1-exp(-k*D))*sin(pi/M)/(pi/M). Shown in the UI so the physics is
 *  falsifiable rather than merely asserted. */
export function selfTest({ pitch = 0.024, thickness = 0.006, Br = 1.32, segments = 4 } = {}) {
  const tile = ARRAY_TYPES.halbach1d.build({ pitch, thickness, Br, segments });
  const harm = decompose(tile, { maxOrder: 5, gapRef: 0, tol: 1e-6 });
  const k = TWO_PI / pitch;
  const analytic = Br * (1 - Math.exp(-k * thickness)) * sinc(Math.PI / segments);
  const model = peakField(harm, 0);
  return {
    analytic, model,
    relError: Math.abs(model - analytic) / analytic,
    pass: Math.abs(model - analytic) / analytic < 0.02,
  };
}
