// Self-intersection validator for GENERATED winding copper. The coil is one
// continuous spiral per layer: every pair of its track elements must either
// share an endpoint (the chain) or keep centreline distance >= the trace
// width. Anything closer is copper touching copper across turns -- a
// turn-to-turn short that NO KiCad DRC reports (same net), which silently
// changes the winding's turn count and resistance. This is the same
// invisible-shorts class as the winding-layer parity bug.
//
//   node coilcheck.mjs <board.kicad_pcb> [--verbose]
//
// Exit 0 and write <board>.coilcheck.json (a content stamp) on pass; exit 1
// with located examples on any violation. readBoard() in mkdsn.mjs REFUSES
// boards without a fresh stamp, so routing tooling cannot run on an
// unvalidated board.
import { readFileSync, writeFileSync, statSync } from 'fs';

const boardPath = process.argv[2];
const verbose = process.argv.includes('--verbose');
if (!boardPath) { console.error('usage: node coilcheck.mjs <board.kicad_pcb>'); process.exit(2); }
const src = readFileSync(boardPath, 'utf8');

// --- collect winding tracks (segments + arcs) grouped by net|layer ----------
const nets = new Map();                          // number -> name
for (const m of src.matchAll(/\(net (\d+) "([^"]*)"\)/g)) nets.set(+m[1], m[2]);
const groups = new Map();                        // "net|layer" -> [{kind, pts..., w}]
const numRe = '(-?[\\d.]+)';
const LK = '(?:\\s*\\(locked\\))?\\s*';           // the (locked) token has parens: [^)]* cannot cross it
const segRe = new RegExp(`\\(segment \\(start ${numRe} ${numRe}\\) \\(end ${numRe} ${numRe}\\) \\(width ${numRe}\\)${LK}\\(layer "([^"]+)"\\) \\(net (\\d+)\\)`, 'g');
const arcRe = new RegExp(`\\(arc \\(start ${numRe} ${numRe}\\) \\(mid ${numRe} ${numRe}\\) \\(end ${numRe} ${numRe}\\) \\(width ${numRe}\\)${LK}\\(layer "([^"]+)"\\) \\(net (\\d+)\\)`, 'g');
const coilNet = (n) => /^coil_\d+$/.test(nets.get(n) || '');
let nSeg = 0, nArc = 0;
for (const m of src.matchAll(segRe)) {
  if (!coilNet(+m[7])) continue;
  const k = `${m[7]}|${m[6]}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push({ a: [+m[1], +m[2]], b: [+m[3], +m[4]], w: +m[5], arc: null });
  nSeg++;
}
for (const m of src.matchAll(arcRe)) {
  if (!coilNet(+m[9])) continue;
  const k = `${m[9]}|${m[8]}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push({ a: [+m[1], +m[2]], b: [+m[5], +m[6]], mid: [+m[3], +m[4]], w: +m[7], arc: true });
  nArc++;
}
if (nSeg + nArc === 0) { console.error('coilcheck: parsed ZERO winding tracks -- parser/board mismatch, refusing to pass'); process.exit(2); }

// --- geometry ---------------------------------------------------------------
// Arcs are sampled into short chords (max sagitta ~2 um at 0.05 mm steps on
// these radii); the comparison threshold carries the sampling slack, and a
// candidate hit is refined with 10x denser sampling before it counts.
const arcPoly = (e, step) => {
  // circle through a, mid, b
  const [ax, ay] = e.a, [mx, my] = e.mid, [bx, by] = e.b;
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  if (Math.abs(d) < 1e-12) return [e.a, e.b];
  const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
  const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  let t0 = Math.atan2(ay - uy, ax - ux), t1 = Math.atan2(by - uy, bx - ux);
  const tm = Math.atan2(my - uy, mx - ux);
  // choose sweep direction that passes through mid
  const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(t1 - t0);
  if (norm(tm - t0) > sweep) sweep -= 2 * Math.PI;   // go the other way
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / step));
  const out = [];
  for (let i = 0; i <= n; i++) out.push([ux + r * Math.cos(t0 + (sweep * i) / n), uy + r * Math.sin(t0 + (sweep * i) / n)]);
  return out;
};
const poly = (e, step) => (e.arc ? arcPoly(e, step) : [e.a, e.b]);
const segSeg = (p1, p2, p3, p4) => {
  // min distance between two segments
  const d1 = [p2[0] - p1[0], p2[1] - p1[1]], d2 = [p4[0] - p3[0], p4[1] - p3[1]];
  const r = [p1[0] - p3[0], p1[1] - p3[1]];
  const a = d1[0] * d1[0] + d1[1] * d1[1], e2 = d2[0] * d2[0] + d2[1] * d2[1];
  const f = d2[0] * r[0] + d2[1] * r[1];
  let s = 0, t = 0;
  if (a > 1e-12) {
    const c = d1[0] * r[0] + d1[1] * r[1];
    if (e2 > 1e-12) {
      const b = d1[0] * d2[0] + d1[1] * d2[1];
      const den = a * e2 - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e2) / den)) : 0;
      t = Math.max(0, Math.min(1, (b * s + f) / e2));
      s = Math.max(0, Math.min(1, (b * t - c) / a));
    } else s = Math.max(0, Math.min(1, -c / a));
  } else if (e2 > 1e-12) t = Math.max(0, Math.min(1, f / e2));
  const px = p1[0] + d1[0] * s - (p3[0] + d2[0] * t), py = p1[1] + d1[1] * s - (p3[1] + d2[1] * t);
  return Math.hypot(px, py);
};
const polyDist = (pa, pb) => {
  let d = Infinity;
  for (let i = 0; i + 1 < pa.length; i++) {
    for (let j = 0; j + 1 < pb.length; j++) d = Math.min(d, segSeg(pa[i], pa[i + 1], pb[j], pb[j + 1]));
  }
  return d;
};
const touches = (e1, e2, eps) =>
  [e1.a, e1.b].some((p) => [e2.a, e2.b].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < eps));
// Chain adjacency: elements sharing an endpoint, or joined through ONE
// intermediate (the corner fillet between two hexagon edges), are contiguous
// corner copper -- a short partial edge at a layer boundary shrinks the
// fillet and the flanking edges legitimately converge near the vertex. A
// turn-to-turn short is always a full turn (~12+ elements) away in the
// chain, so chain distance <= 2 is structurally incapable of being one.
const endKey = (p) => `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)}`;   // 2 um buckets
const chainNear = (elems) => {
  const byEnd = new Map();
  elems.forEach((e, i) => {
    for (const p of [e.a, e.b]) {
      const k = endKey(p);
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push(i);
    }
  });
  const nbr = elems.map(() => new Set());
  for (const ids of byEnd.values()) {
    for (const i of ids) for (const j of ids) if (i !== j) nbr[i].add(j);
  }
  return (i, j) => {
    if (nbr[i].has(j)) return true;
    for (const k of nbr[i]) if (nbr[j].has(k)) return true;
    return false;
  };
};

// --- scan -------------------------------------------------------------------
const STEP = 0.05, CELL = 0.25;
let bad = 0, worst = 0;
const examples = [];
for (const [k, elems] of groups) {
  const [netNo, layer] = k.split('|');
  const name = nets.get(+netNo);
  const near = chainNear(elems);
  const polys = elems.map((e) => poly(e, STEP));
  // point grid: min sampled point-pair distance per element pair, then exact
  // refinement only for pairs already within contact + sampling slack
  const grid = new Map();
  polys.forEach((pts, i) => {
    pts.forEach(([x, y]) => {
      const gk = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      if (!grid.has(gk)) grid.set(gk, []);
      grid.get(gk).push([x, y, i]);
    });
  });
  const pairMin = new Map();                     // i*1e6+j -> min point distance
  for (const [gk, pts] of grid) {
    const [cx, cy] = gk.split(',').map(Number);
    const neigh = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const q = grid.get(`${cx + dx},${cy + dy}`);
        if (q) neigh.push(...q);
      }
    }
    for (const [x, y, i] of pts) {
      for (const [qx, qy, j] of neigh) {
        if (j <= i) continue;
        const d = Math.hypot(x - qx, y - qy);
        const pk = i * 1e6 + j;
        if (!(pairMin.has(pk)) || d < pairMin.get(pk)) pairMin.set(pk, d);
      }
    }
  }
  for (const [pk, dPt] of pairMin) {
    const i = Math.floor(pk / 1e6), j = pk % 1e6;
    const e1 = elems[i], e2 = elems[j];
    const need = (e1.w + e2.w) / 2;              // centreline contact distance
    if (dPt >= need + STEP) continue;            // clear even with sampling slack
    // (point-pair error vs true curve distance is < STEP total; anything at
    // the 0.193 adjacent-turn pitch skips refinement entirely)
    if (touches(e1, e2, 1e-3) || near(i, j)) continue;   // contiguous corner copper
    const dFine = polyDist(poly(e1, STEP / 10), poly(e2, STEP / 10));
    if (dFine < need - 1e-6) {
      bad++;
      worst = Math.max(worst, need - dFine);
      if (examples.length < 12) {
        const p = polys[i][0];
        examples.push(`${name} ${layer} at (${p[0].toFixed(3)},${p[1].toFixed(3)}): gap ${dFine.toFixed(4)} < width ${need.toFixed(4)}`);
      }
    }
  }
}
if (bad) {
  console.error(`SELF-INTERSECTING COPPER: ${bad} touching pairs, worst overlap ${worst.toFixed(4)} mm`);
  for (const e of examples) console.error('  ' + e);
  process.exit(1);
}
const st = statSync(boardPath);
writeFileSync(`${boardPath}.coilcheck.json`, JSON.stringify({ ok: true, size: st.size, mtimeMs: st.mtimeMs }));
console.log(`coilcheck OK: ${groups.size} coil-layer windings, no self-intersections; stamp written`);
if (verbose) console.log(`checked ${[...groups.values()].reduce((s, g) => s + g.length, 0)} elements`);
