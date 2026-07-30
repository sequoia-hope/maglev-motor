// Map winding self-touches to exact spiral features, straight from the
// generator (no board parsing): for each layer, build spiralPath prims,
// find non-adjacent pairs closer than the trace width, and report prim
// indices, positions, and where each sits relative to the layer's clamp.
import { pcbCoilGeometry, spiralPath, spiralVertices, endShiftsFor } from '../src/kicad.js';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));

let g = pcbCoilGeometry(cfg);
console.log('g: turns', g.turns, 'halfOut', g.halfOut.toFixed(4), 'halfIn', g.halfIn.toFixed(4),
  'pitch', g.pitch.toFixed(4), 'trace', g.trace.toFixed(4), 'corner', g.corner.toFixed(4), 'layers', g.layers);
const MODE = process.env.SHIFTS ? 'shifted' : 'bare';
if (process.env.SHIFTS) {
  const S = endShiftsFor(g, { banFlats: [0, 3], banBands: [[0.85, 2.93]] });
  console.log('endShifts', S.map((v) => +v.toFixed(3)).join(','));
  g = { ...g, endShifts: S };
}
const W = g.trace;

const sample = (p, step) => {
  if (p.t === 'seg') return [p.a, p.b];
  const [ax, ay] = p.a, [mx, my] = p.m, [bx, by] = p.b;
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  if (Math.abs(d) < 1e-12) return [p.a, p.b];
  const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
  const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  let t0 = Math.atan2(ay - uy, ax - ux), t1 = Math.atan2(by - uy, bx - ux);
  const tm = Math.atan2(my - uy, mx - ux);
  const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(t1 - t0);
  if (norm(tm - t0) > sweep) sweep -= 2 * Math.PI;
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / step));
  const out = [];
  for (let i = 0; i <= n; i++) out.push([ux + r * Math.cos(t0 + (sweep * i) / n), uy + r * Math.sin(t0 + (sweep * i) / n)]);
  return out;
};
const segSeg = (p1, p2, p3, p4) => {
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
  return Math.hypot(p1[0] + d1[0] * s - (p3[0] + d2[0] * t), p1[1] + d1[1] * s - (p3[1] + d2[1] * t));
};
const polyDist = (pa, pb) => {
  let d = Infinity;
  for (let i = 0; i + 1 < pa.length; i++) for (let j = 0; j + 1 < pb.length; j++) d = Math.min(d, segSeg(pa[i], pa[i + 1], pb[j], pb[j + 1]));
  return d;
};

let total = 0;
for (let L = 0; L < g.layers; L++) {
  const prims = spiralPath(g, L);
  const polys = prims.map((p) => sample(p, 0.02));
  const hits = [];
  for (let i = 0; i < prims.length; i++) {
    for (let j = i + 2; j < prims.length; j++) {     // skip chain neighbours
      // cheap bbox reject
      const A = polys[i], B = polys[j];
      const shared = [prims[i].a, prims[i].b].some((p) => [prims[j].a, prims[j].b].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6));
      if (shared) continue;
      let bd = Infinity;
      for (const [x, y] of A) for (const [qx, qy] of B) { const dd = (x - qx) ** 2 + (y - qy) ** 2; if (dd < bd) bd = dd; }
      if (Math.sqrt(bd) > W + 0.05) continue;
      const d = polyDist(A, B);
      if (d < W - 1e-6) hits.push([i, j, d]);
    }
  }
  total += hits.length;
  if (hits.length) {
    console.log(`layer ${L} (${L % 2 ? 'outward' : 'inward'}): ${prims.length} prims, ${hits.length} touch pairs`);
    for (const [i, j, d] of hits.slice(0, 4)) {
      const pi = prims[i], pj = prims[j];
      const ri = Math.hypot(pi.a[0], pi.a[1]), rj = Math.hypot(pj.a[0], pj.a[1]);
      console.log(`  prim ${i}/${prims.length} (${pi.t}, |a|=${ri.toFixed(3)}) x prim ${j} (${pj.t}, |a|=${rj.toFixed(3)}): gap ${d.toFixed(4)}`
        + `  at (${pi.a[0].toFixed(3)},${pi.a[1].toFixed(3)}) x (${pj.a[0].toFixed(3)},${pj.a[1].toFixed(3)})`);
    }
  }
}
console.log(`${MODE}: total ${total} touch pairs`);
