// Platen CAD: the retainer as a machinable part, not an accounting entry.
//
// The mass model charges a `pocketWall` between every pair of magnet cells, but
// the cells are PITCH-TIGHT: pitch = magnetSize x segments, so adjacent cubes
// touch face-to-face and there is no room for a wall between them without
// stretching the wavelength the field model runs on. A per-cell egg-crate of
// full-size stock cubes cannot exist. What CAN exist follows from the pattern
// itself: the 2-D Halbach nulls are empty cells, isolated from each other and
// distributed through the array -- so the retainer is a plate whose material
// rises THROUGH the void cells as square posts, plus a fence around the rim.
// Every magnet is then boxed in laterally by posts and neighbours; vertical
// retention is the adhesive and the pocket floor.
//
// The posts are islands in the magnet pocket. An island cannot be part of a
// separate lattice plate -- it would fall out -- so the retainer and the
// backing are ONE part, machined from one billet: magnet pocket with integral
// posts from the top, isogrid pockets from the back for stiffness at a
// fraction of the solid plate's mass. Two 2.5-D setups, one STEP solid, one
// DXF per side.
//
// Machinability is part of the geometry, not a note: square magnets must seat
// against flat walls, so every internal (interior-90-degree) pocket corner
// gets an explicit dogbone relief sized for a named tool, and validate() holds
// channel widths, seating flats, fence cover and isogrid inradius to the tools.

import { cellSize, eachCell, cellIsEmpty } from './halbach.js';
import { MATERIALS } from './mechanical.js';

export const DEFAULT_CAD = {
  fenceWidth: 0.002,      // solid rim around the array (grows the footprint if the platen has no border)
  clearance: 0.00005,     // per-side magnet fit clearance (H7-ish slip fit on a ground cube)
  standProud: 0.0001,     // magnets stand this far above posts/fence, so NdFeB defines the gap plane, not aluminium
  toolDia: 0.003175,      // 1/8" pocketing endmill
  dogboneDia: 0.0015875,  // 1/16" corner-relief endmill
  skin: 0.001,            // floor left under the magnets
  ribWidth: 0.0012,       // isogrid rib width
  isoSide: 0,             // isogrid triangle side; 0 = derive from the platen
  material: 'al6061',
};

// ---------------------------------------------------------------- contours ---

/** Trace the boundary of a set of filled grid cells into closed rectilinear
 *  loops, with the filled region on the LEFT of the direction of travel. That
 *  one convention carries the rest of the module: outer loops come out CCW
 *  (positive area), island loops CW, and "offset each edge to the right" grows
 *  the pocket uniformly whether the edge belongs to the rim or to a post. */
function traceLoops(filled, nx, ny) {
  const has = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && filled[j * nx + i];
  const edges = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!has(i, j)) continue;
      if (!has(i, j - 1)) edges.push([[i, j], [i + 1, j]]);
      if (!has(i + 1, j)) edges.push([[i + 1, j], [i + 1, j + 1]]);
      if (!has(i, j + 1)) edges.push([[i + 1, j + 1], [i, j + 1]]);
      if (!has(i - 1, j)) edges.push([[i, j + 1], [i, j]]);
    }
  }
  const key = (p) => p[0] + ',' + p[1];
  const out = new Map();
  for (const e of edges) {
    const k = key(e[0]);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(e);
  }
  const loops = [];
  for (const e0 of edges) {
    if (e0.used) continue;
    const loop = [e0[0]];
    let e = e0;
    for (;;) {
      e.used = true;
      const p = e[1];
      if (p[0] === loop[0][0] && p[1] === loop[0][1]) break;
      loop.push(p);
      const dx = e[1][0] - e[0][0], dy = e[1][1] - e[0][1];
      // At a vertex where two filled cells meet only diagonally, four boundary
      // edges share the point. Take the sharpest LEFT turn: that keeps this
      // loop hugging its own component instead of leaking into the other one.
      let best = null, bestCross = -2;
      for (const c of out.get(key(p)) ?? []) {
        if (c.used) continue;
        const cx = c[1][0] - c[0][0], cy = c[1][1] - c[0][1];
        const cross = dx * cy - dy * cx;
        if (cross > bestCross) { bestCross = cross; best = c; }
      }
      if (!best) break;               // cannot happen on a well-formed grid
      e = best;
    }
    // Merge collinear runs so each loop edge is a full wall, not a cell edge.
    const merged = [];
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) merged.push(b);
    }
    loops.push(merged);
  }
  return loops;
}

const signedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** Offset a rectilinear loop: move every edge a distance d to the RIGHT of its
 *  direction of travel. With filled-on-left loops that grows the pocket -- rim
 *  outward, posts inward -- by the same clearance everywhere. Consecutive
 *  edges are perpendicular (collinear runs were merged), so the new vertex is
 *  exact: x from the vertical edge, y from the horizontal one. */
function offsetLoop(loop, d) {
  const n = loop.length;
  const sh = loop.map((p, i) => {
    const q = loop[(i + 1) % n];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const rx = (q[1] - p[1]) / L, ry = -(q[0] - p[0]) / L;   // right of travel
    return [[p[0] + rx * d, p[1] + ry * d], [q[0] + rx * d, q[1] + ry * d]];
  });
  return loop.map((_, i) => {
    const a = sh[(i - 1 + n) % n], b = sh[i];
    const aVert = Math.abs(a[1][0] - a[0][0]) < 1e-12;
    return aVert ? [a[1][0], b[0][1]] : [b[0][0], a[1][1]];
  });
}

/** Dogbone reliefs: one circle at every interior-90-degree pocket corner (a
 *  LEFT turn under the filled-on-left convention), pushed along the diagonal
 *  into the material so the milled pocket still contains the sharp corner a
 *  square magnet needs. Island (post) corners are convex material -- the tool
 *  wraps them sharp -- so they get nothing, which is what keeps the posts
 *  strong. */
const DOGBONE_BURY = 0.7;  // centre offset as a fraction of r: circle covers the corner with margin
function dogbones(loop, r) {
  const n = loop.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    const inx = b[0] - a[0], iny = b[1] - a[1];
    const outx = c[0] - b[0], outy = c[1] - b[1];
    if (inx * outy - iny * outx <= 0) continue;             // not a left turn
    const iL = Math.hypot(inx, iny), oL = Math.hypot(outx, outy);
    const dx = inx / iL - outx / oL, dy = iny / iL - outy / oL;
    const dL = Math.hypot(dx, dy);
    out.push({ c: [b[0] + (dx / dL) * r * DOGBONE_BURY, b[1] + (dy / dL) * r * DOGBONE_BURY], r });
  }
  return out;
}

/** How far a dogbone bites along the wall from its corner: the chord the
 *  circle cuts on the seating face. This is what the seating-flat check and
 *  the fence-cover check both need, so it is computed once, honestly. */
export function dogboneIntrusion(r) {
  const d = r * DOGBONE_BURY;                // centre distance from the corner
  const off = d / Math.SQRT2;                // centre's distance components along/off the wall
  return off + Math.sqrt(Math.max(r * r - off * off, 0));
}

// ------------------------------------------------------------- magnet side ---

/** The magnet-side pocket geometry for one patch: loops in WORLD coordinates
 *  (patch rotation applied -- the quad layout's arms sit at 90 degrees, which
 *  keeps everything rectilinear), already offset by the fit clearance. */
function patchPocket(tile, patch, clearance, dogR) {
  const [cw, ch] = cellSize(tile);
  const cells = [];
  eachCell(tile, [patch], (u, v, k) => cells.push({ u, v, filled: !cellIsEmpty(tile, k) }));
  if (!cells.length) return null;
  let minU = Infinity, minV = Infinity;
  for (const c of cells) { minU = Math.min(minU, c.u); minV = Math.min(minV, c.v); }
  let nx = 0, ny = 0;
  for (const c of cells) {
    c.i = Math.round((c.u - minU) / cw);
    c.j = Math.round((c.v - minV) / ch);
    nx = Math.max(nx, c.i + 1); ny = Math.max(ny, c.j + 1);
  }
  const filled = new Array(nx * ny).fill(false);
  let nFilled = 0;
  for (const c of cells) if (c.filled) { filled[c.j * nx + c.i] = true; nFilled++; }
  if (!nFilled) return null;

  const x0 = minU - cw / 2, y0 = minV - ch / 2;
  const world = ([i, j]) => {
    const px = x0 + i * cw, py = y0 + j * ch;
    return [patch.u + px * patch.cos - py * patch.sin,
            patch.v + px * patch.sin + py * patch.cos];
  };
  const loops = traceLoops(filled, nx, ny)
    .map((lp) => offsetLoop(lp.map(world), clearance))
    .map((pts) => ({ pts, area: signedArea(pts) }));
  const outers = loops.filter((l) => l.area > 0);
  const holes = loops.filter((l) => l.area < 0);
  // A post belongs to the region that surrounds it; with one region per patch
  // (every preset today) this is trivial, but the quad layout earns the check.
  const inside = (pt, poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1])
        && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  for (const o of outers) o.holes = [];
  for (const h of holes) {
    const o = outers.find((o2) => inside(h.pts[0], o2.pts)) ?? outers[0];
    o.holes.push(h);
  }
  const reliefs = loops.flatMap((l) => dogbones(l.pts, dogR));
  const cellRects = cells.filter((c) => c.filled).map((c) => {
    const h = [[c.u - cw / 2, c.v - ch / 2], [c.u + cw / 2, c.v - ch / 2],
               [c.u + cw / 2, c.v + ch / 2], [c.u - cw / 2, c.v + ch / 2]];
    return h.map(([x, y]) => [patch.u + x * patch.cos - y * patch.sin,
                              patch.v + x * patch.sin + y * patch.cos]);
  });
  // Array extent in world coordinates, for the fence/footprint decision.
  let ext = 0;
  for (const l of loops) for (const p of l.pts) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
  return { outers, holes, reliefs, cellRects, nFilled, nCells: cells.length, extent: ext, cellW: cw, cellH: ch };
}

// ---------------------------------------------------------------- isogrid ----

/** Equilateral triangulation clipped to the usable square. Vertex lattice
 *  V(i,j) = ((i + j/2) s, j h); up and down triangles between adjacent rows
 *  tile the plane, and only triangles whose rib-inset pocket fits entirely
 *  inside the usable region are kept -- partial triangles become solid border,
 *  which is exactly what a clamping edge wants to be anyway. */
function isogridTriangles(half, band, side, ribW) {
  const h = side * Math.sqrt(3) / 2;
  const usable = half - band;
  const shrink = (side - Math.sqrt(3) * ribW) / side;    // inset side / full side
  if (shrink <= 0) return [];
  const J = Math.ceil(usable / h) + 1, I = Math.ceil(2 * usable / side) + J + 1;
  const V = (i, j) => [(i + j / 2) * side, j * h];
  const tris = [];
  const consider = (a, b, c) => {
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
    const pts = [a, b, c].map(([x, y]) => [cx + (x - cx) * shrink, cy + (y - cy) * shrink]);
    for (const [x, y] of pts) if (Math.abs(x) > usable || Math.abs(y) > usable) return;
    if (signedArea(pts) < 0) pts.reverse();
    tris.push(pts);
  };
  for (let j = -J; j < J; j++) {
    for (let i = -I; i < I; i++) {
      consider(V(i, j), V(i + 1, j), V(i, j + 1));
      consider(V(i + 1, j), V(i + 1, j + 1), V(i, j + 1));
    }
  }
  return tris;
}

/** Smeared isogrid bending stiffness per unit width, against the same-material
 *  solid plate. The rib layer is three rod families at 0/60/120 degrees,
 *  spacing h = s*sqrt(3)/2, each a volume fraction w/h of its layer: summing
 *  the fibre transformation over the three angles gives an isotropic in-plane
 *  stiffness of (9/8) E w/h. Skin and rib layer are then integrated about
 *  their common neutral axis. Poisson terms are dropped on BOTH sides of the
 *  comparison, so the ratio is honest even where the absolute D is ~10% shy. */
export function isogridStiffness({ skin, ribW, ribD, side, E }) {
  const h = side * Math.sqrt(3) / 2;
  const eRib = E * (9 / 8) * (ribW / h);       // smeared modulus of the rib layer
  // Layers, z measured from the ribbed face: ribs [0, ribD], skin [ribD, ribD+skin].
  const layers = [
    { e: eRib, z0: 0, z1: ribD },
    { e: E, z0: ribD, z1: ribD + skin },
  ];
  let ea = 0, eaz = 0;
  for (const L of layers) { const t = L.z1 - L.z0; ea += L.e * t; eaz += L.e * t * (L.z0 + L.z1) / 2; }
  const zbar = eaz / ea;
  let D = 0;
  for (const L of layers) {
    const a = L.z0 - zbar, b = L.z1 - zbar;
    D += L.e * (b * b * b - a * a * a) / 3;
  }
  const t = skin + ribD;
  const solidD = E * t * t * t / 12;           // solid plate of the same overall thickness
  return { D, solidD, ratio: D / solidD };
}

// ------------------------------------------------------------------- part ----

/** The whole part, as geometry plus the checks that make it machinable. Pure
 *  function of the config; the exporters below only serialise what this says. */
export function platenCad(cfg, tr, mech, cad = {}) {
  const c = { ...DEFAULT_CAD, ...cad };
  const t = cfg.translator;
  const magT = t.magnetThickness;
  const dogR = c.dogboneDia / 2;

  const patches = tr.patches.map((p) => patchPocket(tr.tile, p, c.clearance, dogR)).filter(Boolean);
  const extent = Math.max(...patches.map((p) => p.extent));
  // The footprint honours the configured platen when it already has a border;
  // a platen sized exactly to the array (amz316) grows by the fence, and the
  // card says so rather than silently shaving the rim cells.
  const half = Math.max(t.platenSize / 2, extent + c.fenceWidth);
  const fence = half - extent;

  const pocketDepth = magT - c.standProud;
  const skin = Math.min(c.skin, Math.max(mech.backingThickness - 0.0005, 0.0002));
  const ribDepth = mech.backingThickness - skin;
  const thickness = pocketDepth + skin + ribDepth;

  const isoSide = c.isoSide > 0 ? c.isoSide : Math.max(3 * Math.min(...patches.map((p) => p.cellW)), (2 * half) / 5);
  const triangles = isogridTriangles(half, Math.max(fence, c.fenceWidth), isoSide, c.ribWidth);

  // ---- masses, from the geometry that will actually be cut ----------------
  const rho = (MATERIALS[c.material] ?? MATERIALS.al6061).rho;
  const loopArea = (ps) => ps.reduce((a, l) => a + signedArea(l.pts), 0);
  const pocketArea = patches.reduce((a, p) => a + loopArea(p.outers) + loopArea(p.holes), 0);
  const nReliefs = patches.reduce((a, p) => a + p.reliefs.length, 0);
  const reliefArea = nReliefs * Math.PI * dogR * dogR * 0.5;   // roughly half of each circle is new void
  const triArea = triangles.reduce((a, tri) => a + signedArea(tri), 0);
  const W = 2 * half;
  const volume = W * W * thickness - (pocketArea + reliefArea) * pocketDepth - triArea * ribDepth;
  const mass = volume * rho;

  const E = (MATERIALS[c.material] ?? MATERIALS.al6061).E;
  const stiff = isogridStiffness({ skin, ribW: c.ribWidth, ribD: ribDepth, side: isoSide, E });
  const solidBackingMass = W * W * mech.backingThickness * rho;
  const backingSectionMass = (W * W * (skin + ribDepth) - triArea * ribDepth) * rho;

  // ---- machinability checks ----------------------------------------------
  const cellW = Math.min(...patches.map((p) => p.cellW));
  const intr = dogboneIntrusion(dogR);
  const seat = (cellW - 2 * intr) / cellW;
  const inr = (isoSide - Math.sqrt(3) * c.ribWidth) / (2 * Math.sqrt(3));
  const mm = (x) => (x * 1000).toFixed(2);
  const checks = [
    { ok: c.toolDia <= cellW + 2 * c.clearance,
      msg: `pocket channels are one cell (${mm(cellW)} mm) wide — ${mm(c.toolDia)} mm roughing tool ${c.toolDia <= cellW ? 'fits' : 'DOES NOT FIT'}` },
    { ok: seat >= 0.4,
      msg: `dogbones leave ${(seat * 100).toFixed(0)}% of each cell wall as seating flat (${mm(intr)} mm bite per corner, ${mm(c.dogboneDia)} mm relief tool)` },
    { ok: fence >= intr + 0.0005,
      msg: `fence is ${mm(fence)} mm — ${fence >= intr + 0.0005 ? 'covers' : 'TOO THIN for'} the rim dogbones (${mm(intr)} mm bite)` },
    { ok: inr >= c.toolDia / 2,
      msg: `isogrid pocket inradius ${mm(inr)} mm vs ${mm(c.toolDia / 2)} mm tool radius` },
    { ok: skin >= 0.0005,
      msg: `${mm(skin)} mm floor under the magnets` },
    { ok: ribDepth > 0,
      msg: `${mm(ribDepth)} mm isogrid ribs under a ${mm(skin)} mm skin (= ${mm(mech.backingThickness)} mm backing budget)` },
    { ok: triangles.length > 0,
      msg: `${triangles.length} isogrid pockets at ${mm(isoSide)} mm triangle side, ${mm(c.ribWidth)} mm ribs` },
  ];

  return {
    cad: c, footprint: W, half, fence, extent: 2 * extent,
    thickness, pocketDepth, skin, ribDepth,
    patches, triangles, isoSide,
    nPockets: patches.reduce((a, p) => a + p.nFilled, 0),
    nPosts: patches.reduce((a, p) => a + p.holes.length, 0),
    nReliefs,
    mass, volume, rho,
    backingSectionMass, solidBackingMass,
    stiffness: stiff,
    grown: W > t.platenSize + 1e-9,
    checks, ok: checks.every((k) => k.ok),
  };
}

// ------------------------------------------------------------------- DXF -----

const D6 = (x) => (Math.round(x * 1e9) / 1e3).toFixed(4);   // metres -> mm string

function dxfDoc(layers, entities) {
  const L = [];
  const push = (code, val) => { L.push(String(code), String(val)); };
  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');
  push(0, 'ENDSEC');
  push(0, 'SECTION'); push(2, 'TABLES');
  push(0, 'TABLE'); push(2, 'LTYPE'); push(70, 1);
  push(0, 'LTYPE'); push(2, 'CONTINUOUS'); push(70, 0); push(3, 'Solid line'); push(72, 65); push(73, 0); push(40, 0);
  push(0, 'ENDTAB');
  push(0, 'TABLE'); push(2, 'LAYER'); push(70, layers.length);
  for (const [name, color] of layers) {
    push(0, 'LAYER'); push(2, name); push(70, 0); push(62, color); push(6, 'CONTINUOUS');
  }
  push(0, 'ENDTAB'); push(0, 'ENDSEC');
  push(0, 'SECTION'); push(2, 'ENTITIES');
  for (const e of entities) {
    if (e.type === 'poly') {
      push(0, 'POLYLINE'); push(8, e.layer); push(66, 1); push(70, 1);
      for (const p of e.pts) { push(0, 'VERTEX'); push(8, e.layer); push(10, D6(p[0])); push(20, D6(p[1])); }
      push(0, 'SEQEND');
    } else if (e.type === 'circle') {
      push(0, 'CIRCLE'); push(8, e.layer); push(10, D6(e.c[0])); push(20, D6(e.c[1])); push(40, D6(e.r));
    } else if (e.type === 'text') {
      push(0, 'TEXT'); push(8, e.layer); push(10, D6(e.p[0])); push(20, D6(e.p[1]));
      push(40, D6(e.h)); push(1, e.text);
    }
  }
  push(0, 'ENDSEC'); push(0, 'EOF');
  return L.join('\n') + '\n';
}

const square = (h) => [[-h, -h], [h, -h], [h, h], [-h, h]];

/** Magnet-side DXF: OUTLINE, POCKET (region between the outer contour and the
 *  post islands, cut pocketDepth deep), RELIEF (dogbone circles -- these are
 *  geometry, not advice: without them the cubes do not seat), CELLS (reference
 *  squares, one per magnet, for inspection and the loading jig). Units mm. */
export function magnetGridDxf(cad) {
  const ents = [{ type: 'poly', layer: 'OUTLINE', pts: square(cad.half) }];
  for (const p of cad.patches) {
    for (const l of [...p.outers, ...p.holes]) ents.push({ type: 'poly', layer: 'POCKET', pts: l.pts });
    for (const r of p.reliefs) ents.push({ type: 'circle', layer: 'RELIEF', c: r.c, r: r.r });
    for (const cr of p.cellRects) ents.push({ type: 'poly', layer: 'CELLS', pts: cr });
  }
  const mm = (x) => (x * 1000).toFixed(2);
  const th = cad.footprint / 60;
  ents.push({ type: 'text', layer: 'NOTES', p: [-cad.half, -cad.half - 3 * th], h: th,
    text: `UNITS MM - POCKET ${mm(cad.pocketDepth)} DEEP - RELIEF IS ${mm(cad.cad.dogboneDia)} TOOL, SAME DEPTH - ISLANDS ARE POSTS, DO NOT CUT` });
  return dxfDoc([['OUTLINE', 7], ['POCKET', 1], ['RELIEF', 3], ['CELLS', 8], ['NOTES', 7]], ents);
}

/** Isogrid-side DXF, mirrored about X so it is tool-view for the second setup
 *  (the part is flipped over to cut the back). Units mm. */
export function isogridDxf(cad) {
  const mir = ([x, y]) => [-x, y];
  const ents = [{ type: 'poly', layer: 'OUTLINE', pts: square(cad.half) }];
  for (const tri of cad.triangles) ents.push({ type: 'poly', layer: 'POCKET', pts: tri.map(mir).reverse() });
  const mm = (x) => (x * 1000).toFixed(2);
  const th = cad.footprint / 60;
  ents.push({ type: 'text', layer: 'NOTES', p: [-cad.half, -cad.half - 3 * th], h: th,
    text: `UNITS MM - MIRRORED (TOOL VIEW OF BACK FACE) - POCKET ${mm(cad.ribDepth)} DEEP - LEAVE ${mm(cad.skin)} SKIN` });
  return dxfDoc([['OUTLINE', 7], ['POCKET', 5], ['NOTES', 7]], ents);
}

// ---------------------------------------------------------------- preview ----

/** Top views of both setups, in the style of the coil preview: what gets cut,
 *  before anyone downloads anything. Magnet side shows the pocket (gold), the
 *  posts and fence left standing, the dogbone reliefs (green) and the magnet
 *  cells (faint); isogrid side shows the triangle pockets (blue). */
export function platenPreviewSVG(cad) {
  const P = (p) => `${(p[0] * 1000).toFixed(3)},${(-p[1] * 1000).toFixed(3)}`;
  const path = (loops, fill, stroke, w) =>
    `<path d="${loops.map((l) => 'M' + l.map(P).join('L') + 'Z').join('')}" fill-rule="evenodd" fill="${fill}" stroke="${stroke}" stroke-width="${w}"/>`;
  const h = cad.half * 1000, m = h * 1.05;
  const frame = (parts) =>
    `<svg viewBox="${-m} ${-m} ${2 * m} ${2 * m}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#0b0e14;border-radius:6px">`
    + `<rect x="${-h}" y="${-h}" width="${2 * h}" height="${2 * h}" fill="#1a2230" stroke="#e8ecf4" stroke-width="${h / 90}"/>`
    + parts.join('') + '</svg>';

  const mag = [];
  const loops = cad.patches.flatMap((p) => [...p.outers.map((l) => l.pts), ...p.holes.map((l) => l.pts)]);
  mag.push(path(loops, '#10141c', '#e0a83c', h / 90));
  for (const p of cad.patches) for (const cr of p.cellRects)
    mag.push(`<polygon points="${cr.map(P).join(' ')}" fill="none" stroke="#8884" stroke-width="${h / 180}" stroke-dasharray="${h / 60} ${h / 90}"/>`);
  for (const p of cad.patches) for (const r of p.reliefs)
    mag.push(`<circle cx="${(r.c[0] * 1000).toFixed(3)}" cy="${(-r.c[1] * 1000).toFixed(3)}" r="${(r.r * 1000).toFixed(3)}" fill="none" stroke="#4cd97b" stroke-width="${h / 120}"/>`);

  const iso = [path(cad.triangles, '#10141c', '#6ea8fe', h / 90)];
  return { magnetSvg: frame(mag), isogridSvg: frame(iso) };
}

// ------------------------------------------------------------------- STEP ----

/** One manifold solid, AP214, millimetres. Sharp design geometry: the dogbone
 *  reliefs live in the DXF (and in any CAM operator's corner strategy), not in
 *  the B-rep, so the STEP stays a clean prismatic part every CAD kernel heals
 *  without fuss. Every face is planar; edges and vertices are shared through
 *  the maps below, so the shell is genuinely closed -- the test suite counts
 *  two uses of every edge rather than taking that on faith. */
export function platenStep(cad, name = 'maglev-platen') {
  let n = 0;
  const lines = [];
  const add = (txt) => { const id = ++n; lines.push(`#${id}=${txt};`); return `#${id}`; };
  const R = (x) => {
    let s = String(Math.round(x * 1e7) / 1e4);               // metres -> mm
    if (!s.includes('.') && !s.includes('E')) s += '.';
    return s;
  };

  const app = add(`APPLICATION_CONTEXT('automotive design')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,${app})`);
  const pctx = add(`PRODUCT_CONTEXT('',${app},'mechanical')`);
  const prod = add(`PRODUCT('${name}','${name}','',(${pctx}))`);
  const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pdc = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`);
  const pd = add(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`);
  const pds = add(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  const uLen = add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const uAng = add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const uSol = add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-4),${uLen},'distance_accuracy_value','')`);
  const gctx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${uLen},${uAng},${uSol}))REPRESENTATION_CONTEXT('',''))`);

  const pts = new Map(), verts = new Map(), edges = new Map(), dirs = new Map();
  const pKey = (p) => p.map((x) => Math.round(x * 1e7)).join(',');
  const point = (p) => {
    const k = pKey(p);
    if (!pts.has(k)) pts.set(k, add(`CARTESIAN_POINT('',(${R(p[0])},${R(p[1])},${R(p[2])}))`));
    return pts.get(k);
  };
  // DIRECTION components are reals and must carry a decimal point.
  const dirStr = (d) => d.map((x) => { let s = String(Math.round(x * 1e6) / 1e6); if (!s.includes('.')) s += '.'; return s; }).join(',');
  const direction2 = (d) => {
    const k = dirStr(d);
    if (!dirs.has(k)) dirs.set(k, add(`DIRECTION('',(${k}))`));
    return dirs.get(k);
  };
  const vertex = (p) => {
    const k = pKey(p);
    if (!verts.has(k)) verts.set(k, add(`VERTEX_POINT('',${point(p)})`));
    return verts.get(k);
  };
  const edge = (a, b) => {
    const ka = pKey(a), kb = pKey(b);
    const fwd = ka < kb;
    const k = fwd ? ka + '|' + kb : kb + '|' + ka;
    if (!edges.has(k)) {
      const [p, q] = fwd ? [a, b] : [b, a];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const d = [(q[0] - p[0]) / L, (q[1] - p[1]) / L, (q[2] - p[2]) / L];
      const vec = add(`VECTOR('',${direction2(d)},1.)`);
      const lin = add(`LINE('',${point(p)},${vec})`);
      edges.set(k, { id: add(`EDGE_CURVE('',${vertex(p)},${vertex(q)},${lin},.T.)`), uses: 0 });
    }
    const e = edges.get(k);
    e.uses++;
    return { ref: e.id, same: fwd };
  };
  const loopRef = (pts3) => {
    const oes = [];
    for (let i = 0; i < pts3.length; i++) {
      const a = pts3[i], b = pts3[(i + 1) % pts3.length];
      const { ref, same } = edge(a, b);
      oes.push(add(`ORIENTED_EDGE('',*,*,${ref},${same ? '.T.' : '.F.'})`));
    }
    return add(`EDGE_LOOP('',(${oes.join(',')}))`);
  };
  const faceIds = [];
  const face = (loops, normal) => {
    // loops[0] outer, already wound CCW about the outward normal; holes CW.
    const o = loops[0][0];
    const refd = Math.abs(normal[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1];
    const ax = add(`AXIS2_PLACEMENT_3D('',${point(o)},${direction2(normal)},${direction2(refd)})`);
    const plane = add(`PLANE('',${ax})`);
    const bounds = loops.map((lp, i) =>
      add(`${i === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${loopRef(lp)},.T.)`));
    faceIds.push(add(`ADVANCED_FACE('',(${bounds.join(',')}),${plane},.T.)`));
  };

  const at = (lp2, z) => lp2.map(([x, y]) => [x, y, z]);
  const rev = (lp) => [...lp].reverse();
  const hw = cad.half, T = cad.thickness, zf = T - cad.pocketDepth, zr = cad.ribDepth;
  const sq = square(hw);                                     // CCW in xy

  // Vertical wall along a loop edge a->b over [z0,z1]. All pocket loops carry
  // void-on-left, so the outward normal is the LEFT of travel for every wall,
  // rim or island alike; plate sides pass material-on-left loops and flip.
  const wall = (a, b, z0, z1) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nrm = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L, 0];
    face([[[a[0], a[1], z1], [b[0], b[1], z1], [b[0], b[1], z0], [a[0], a[1], z0]]], nrm);
  };
  const walls = (lp, z0, z1) => {
    for (let i = 0; i < lp.length; i++) wall(lp[i], lp[(i + 1) % lp.length], z0, z1);
  };

  // Top: fence face (footprint minus every pocket outer), post tops, floors, walls.
  const outers = cad.patches.flatMap((p) => p.outers.map((l) => l.pts));
  const holes = cad.patches.flatMap((p) => p.holes.map((l) => l.pts));
  face([at(sq, T), ...outers.map((l) => at(rev(l), T))], [0, 0, 1]);
  for (const h of holes) face([at(rev(h), T)], [0, 0, 1]);
  for (const p of cad.patches) {
    for (const o of p.outers) face([at(o.pts, zf), ...o.holes.map((h) => at(h.pts, zf))], [0, 0, 1]);
  }
  for (const l of [...outers, ...holes]) walls(l, zf, T);

  // Bottom: plate face (footprint minus triangles), triangle floors and walls.
  // Normal -z: wound CW in the xy view, so reverse what is CCW there.
  face([at(rev(sq), 0), ...cad.triangles.map((tri) => at(tri, 0))], [0, 0, -1]);
  for (const tri of cad.triangles) face([at(rev(tri), zr)], [0, 0, -1]);
  for (const tri of cad.triangles) walls(tri, 0, zr);

  // Sides: the footprint loop carries material on the LEFT, so the outward
  // normal is the RIGHT of travel -- walls() would face them inward. Reverse.
  walls(rev(sq), 0, T);

  const shell = add(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
  const solid = add(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
  const origin = add(`AXIS2_PLACEMENT_3D('',${point([0, 0, 0])},${direction2([0, 0, 1])},${direction2([1, 0, 0])})`);
  const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${origin},${solid}),${gctx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);

  let bad = 0;
  for (const e of edges.values()) if (e.uses !== 2) bad++;

  const head = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('maglev platen: magnet grid over isogrid, one billet'),'2;1');
FILE_NAME('${name}.step','',(''),(''),'','magnet-sim cad.js','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
`;
  return { text: head + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n',
    stats: { entities: n, faces: faceIds.length, edges: edges.size, openEdges: bad } };
}
