// An independent, exact field model, kept deliberately unlike the one it checks.
//
// src/halbach.js expands the magnetisation in spatial harmonics and assumes the
// array is infinite. That is fast, and it is the right model for the interior,
// but it can only ever be self-consistent -- a sign error inside it reproduces
// itself in every quantity derived from it, including the controller that
// inverts it, so the simulator flies happily on a field no physical array
// produces. (It did: the in-plane components were inverted relative to Bz from
// the first commit until 2026-07-22, and every magnitude in the UI was correct
// the whole time.)
//
// This model shares no code and no assumptions with that one. It sums the exact
// closed-form field of each cuboid block -- Furlani's charge-sheet solution --
// over a finite array. No periodicity, no harmonics, no truncation order, and
// real edges. It is far too slow for the sim loop and exactly right for a test.

const { log, atan2, sqrt, PI, hypot } = Math;

/** Field of one cuboid centred at the origin with half-sizes (a,b,c),
 *  magnetised along +z with remanence Br (tesla), evaluated at (x,y,z).
 *  Accumulates into `out`. */
function boxZ(Br, a, b, c, x, y, z, out) {
  let bx = 0, by = 0, bz = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 2; k++) {
        const s = (i + j + k) % 2 ? -1 : 1;
        const X = x - (i ? a : -a), Y = y - (j ? b : -b), Z = z - (k ? c : -c);
        const R = sqrt(X * X + Y * Y + Z * Z);
        bx += s * log(Y + R);
        by += s * log(X + R);
        bz -= s * atan2(X * Y, Z * R);
      }
    }
  }
  const f = Br / (4 * PI);
  out[0] += f * bx; out[1] += f * by; out[2] += f * bz;
  return out;
}

/** Field of a cuboid with an arbitrary magnetisation vector m (tesla), by
 *  superposing three axis-magnetised boxes. Each is evaluated by rotating the
 *  field point into that axis' frame and rotating the result back, so the one
 *  closed form above serves all three directions. */
export function boxField(m, hx, hy, hz, dx, dy, dz, out) {
  if (m[2]) boxZ(m[2], hx, hy, hz, dx, dy, dz, out);
  if (m[0]) {                       // +x: relabel (x,y,z) -> (y,z,x)
    const t = [0, 0, 0];
    boxZ(m[0], hy, hz, hx, dy, dz, dx, t);
    out[0] += t[2]; out[1] += t[0]; out[2] += t[1];
  }
  if (m[1]) {                       // +y: relabel (x,y,z) -> (z,x,y)
    const t = [0, 0, 0];
    boxZ(m[1], hz, hx, hy, dz, dx, dy, t);
    out[0] += t[1]; out[1] += t[2]; out[2] += t[0];
  }
  return out;
}

/** Field of a whole array of equal-sized blocks: cells are {x, y, m}, `cell` is
 *  the block edge in the plane and `th` its thickness. Blocks are centred on
 *  z = 0, so the faces sit at +/- th/2. */
export function arrayField(cells, cell, th, x, y, z) {
  // The closed form has integrable log singularities on the planes containing a
  // block face, and a regular sample grid lands on them exactly -- which reads
  // as NaN rather than as the finite value the sum actually has. Shift the field
  // point by a sub-nanometre irrational amount: physically nothing, numerically
  // the difference between a field map and a hole in one.
  x += 1.7e-9; y += 2.3e-9;
  const out = [0, 0, 0], h = cell / 2, hz = th / 2;
  for (const c of cells) boxField(c.m, h, h, hz, x - c.x, y - c.y, z, out);
  return out;
}

/** Lay a tile out over cell indices [lo,hi] on both axes, dropping the nulls.
 *  Registration matches the RAW harmonic frame of src/halbach.js (fieldLocal):
 *  cell index i is centred at (i + 0.5)*cell and takes its magnetisation from
 *  tile cell i mod n. NOTE the physical blocks (axisCells/eachCell) sit half a
 *  cell off this frame -- fieldAt() bridges the two via tr.phase, and
 *  field.test 5b pins that bridge. Compare layTile output against fieldLocal,
 *  or eachCell output against fieldAt; never mix the frames. */
export function layTile(tile, seg, cell, lo, hi) {
  const cells = [];
  for (let j = lo; j <= hi; j++) {
    for (let i = lo; i <= hi; i++) {
      const q = tile.ny === 1 ? 0 : ((j % seg) + seg) % seg;
      const k = (q * tile.nx + (((i % seg) + seg) % seg)) * 3;
      const m = [tile.cells[k], tile.cells[k + 1], tile.cells[k + 2]];
      if (hypot(m[0], m[1], m[2]) > 1e-9) {
        cells.push({ x: (i + 0.5) * cell, y: (j + 0.5) * cell, m });
      }
    }
  }
  return cells;
}
