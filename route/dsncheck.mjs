// What is ILLEGAL in a routing DSN before the router adds anything? Freerouting
// reports pre-existing violations only as a count, and a violation doubles as a
// connection in its graph -- so a dirty input silently inflates "routed".
// Parse the DSN's placement + padstacks and report every pad pair closer than
// the clearance rule, per layer.
//   node dsncheck.mjs <file.dsn>
import { readFileSync } from 'fs';

const txt = readFileSync(process.argv[2] || 'sw_c3.dsn', 'utf8');
const clearance = +(txt.match(/\(clearance (\d+)\)/) || [0, 90])[1] / 1000;

// padstacks: id -> [{layer, kind, pts|dia}]
const stacks = new Map();
for (const m of txt.matchAll(/\(padstack "?([\w]+)"?\n([\s\S]*?)\n {4}\)/g)) {
  const shapes = [];
  for (const s of m[2].matchAll(/\(shape \(polygon (\S+) \d+ ([^)]+)\)\)/g)) {
    const nums = s[2].trim().split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i < nums.length; i += 2) pts.push([nums[i] / 1000, nums[i + 1] / 1000]);
    shapes.push({ layer: s[1], kind: 'poly', pts });
  }
  for (const s of m[2].matchAll(/\(shape \(circle (\S+) (\d+)\)\)/g)) {
    shapes.push({ layer: s[1], kind: 'circle', dia: +s[2] / 1000 });
  }
  stacks.set(m[1], shapes);
}
// placements: image id -> [(ref, x, y)]
const pads = [];   // {ref, x, y, shapes}
for (const m of txt.matchAll(/\(component IMG_(\w+)\n([\s\S]*?)\n {4}\)/g)) {
  const img = m[1];
  for (const p of m[2].matchAll(/\(place (\S+) (-?\d+) (-?\d+) front/g)) {
    pads.push({ ref: p[1], x: +p[2] / 1000, y: +p[3] / 1000, shapes: stacks.get(img) || [] });
  }
}
console.log(`${pads.length} pads, ${stacks.size} padstacks, clearance ${clearance}`);

const polyR = (pts) => Math.max(...pts.map(([x, y]) => Math.hypot(x, y)));
const shapeR = (s) => (s.kind === 'circle' ? s.dia / 2 : polyR(s.pts));
// separation of two convex shapes, coarse: distance between centres minus
// bounding radii understates -- for exact-enough reporting use polygon point
// sampling against the other's edges. Keep it simple: bounding-circle prefilter
// then dense point sampling.
const sample = (s, cx, cy) => {
  if (s.kind === 'circle') {
    const out = [];
    for (let a = 0; a < 32; a++) out.push([cx + (s.dia / 2) * Math.cos(a * Math.PI / 16), cy + (s.dia / 2) * Math.sin(a * Math.PI / 16)]);
    out.push([cx, cy]);
    return out;
  }
  const out = [];
  const P = s.pts;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    for (let t = 0; t < 1; t += 0.2) out.push([cx + a[0] + (b[0] - a[0]) * t, cy + a[1] + (b[1] - a[1]) * t]);
  }
  return out;
};
const segDist = (p, s, cx, cy) => {
  // point to polygon/circle boundary distance (outside positive, inside ~0)
  if (s.kind === 'circle') return Math.hypot(p[0] - cx, p[1] - cy) - s.dia / 2;
  let best = 1e9;
  const P = s.pts;
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const xi = P[i][0] + cx, yi = P[i][1] + cy, xj = P[j][0] + cx, yj = P[j][1] + cy;
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) inside = !inside;
    const vx = xj - xi, vy = yj - yi;
    const L = vx * vx + vy * vy || 1;
    let t = ((p[0] - xi) * vx + (p[1] - yi) * vy) / L;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (xi + vx * t), p[1] - (yi + vy * t)));
  }
  return inside ? -best : best;
};

let bad = 0;
for (let i = 0; i < pads.length; i++) {
  for (let j = i + 1; j < pads.length; j++) {
    const A = pads[i], B = pads[j];
    const rA = Math.max(...A.shapes.map(shapeR)), rB = Math.max(...B.shapes.map(shapeR));
    const d = Math.hypot(A.x - B.x, A.y - B.y);
    if (d > rA + rB + clearance + 0.05) continue;
    for (const sa of A.shapes) {
      const sb = B.shapes.find((s) => s.layer === sa.layer);
      if (!sb) continue;
      let min = 1e9;
      for (const p of sample(sa, A.x, A.y)) min = Math.min(min, segDist(p, sb, B.x, B.y));
      if (min < clearance - 1e-6) {
        console.log(`${A.ref} <-> ${B.ref} on ${sa.layer}: gap ${min.toFixed(3)} < ${clearance}`);
        bad++;
      }
      break;   // one layer is enough to report the pair
    }
  }
}
console.log(`${bad} violating pairs`);
