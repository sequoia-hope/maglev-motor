// Geometric connectivity verdict for ANY routed session against a pin map:
//   node checkses.mjs <pins.json> <session.ses> [--quiet]
// A pin map is [{net, x, y, label, w, h}]; copper joins pins when it lands on
// them. This is the truth metric -- freerouting's own unrouted count
// under-reports on anchor nets (measured; see single-cell-periodic-routing).
import { readFileSync } from 'fs';

const pins = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ses = readFileSync(process.argv[3], 'utf8');
const quiet = process.argv.includes('--quiet');

const res = ses.match(/\(resolution (\w+) (\d+)\)/);
const scale = ((res ? res[1] : 'um') === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
const segs = [], svias = [];
const routes = ses.slice(ses.indexOf('(network_out'));
for (const nm of routes.matchAll(/\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g)) {
  const name = nm[1], sbody = nm[2];
  for (const w of sbody.matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
    const nums = w[3].trim().split(/\s+/).map(Number);
    for (let i = 0; i + 3 < nums.length; i += 2) {
      segs.push({ net: name, a: [nums[i] * scale, -nums[i + 1] * scale], b: [nums[i + 2] * scale, -nums[i + 3] * scale] });
    }
  }
  for (const v of sbody.matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
    const [x, y] = v[1].trim().split(/\s+/).map(Number);
    svias.push({ net: name, x: x * scale, y: -y * scale });
  }
}

const EPS = 0.06;
const ptSeg = (px, py, s) => {
  const vx = s.b[0] - s.a[0], vy = s.b[1] - s.a[1];
  const L = vx * vx + vy * vy;
  let t = L > 1e-12 ? ((px - s.a[0]) * vx + (py - s.a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.a[0] + t * vx), py - (s.a[1] + t * vy));
};
const nets = [...new Set(pins.map((p) => p.net))];
let bad = 0, ok = 0, missing = [];
for (const net of nets) {
  const np = pins.filter((p) => p.net === net);
  const ns = segs.filter((s) => s.net === net);
  const nv = svias.filter((v) => v.net === net);
  const N0 = np.length, N1 = N0 + ns.length, N2 = N1 + nv.length;
  const parent = Array.from({ length: N2 }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  // pins that share a `join` key are connected by copper OUTSIDE this session
  // (e.g. two barrel taps on one constructed lane) -- pre-union them
  const joined = new Map();
  np.forEach((p, i) => {
    if (!p.join) return;
    if (joined.has(p.join)) uni(i, joined.get(p.join));
    else joined.set(p.join, i);
  });
  for (let i = 0; i < N0; i++) {
    const r = Math.hypot(np[i].w || 0.5, np[i].h || 0.5) / 2 + EPS;
    ns.forEach((s, k) => { if (ptSeg(np[i].x, np[i].y, s) < r) uni(i, N0 + k); });
    nv.forEach((v, k) => { if (Math.hypot(np[i].x - v.x, np[i].y - v.y) < r + 0.25) uni(i, N1 + k); });
  }
  for (let k = 0; k < ns.length; k++) {
    for (let m = k + 1; m < ns.length; m++) {
      const s1 = ns[k], s2 = ns[m];
      if (ptSeg(s1.a[0], s1.a[1], s2) < 0.1 + EPS || ptSeg(s1.b[0], s1.b[1], s2) < 0.1 + EPS
        || ptSeg(s2.a[0], s2.a[1], s1) < 0.1 + EPS || ptSeg(s2.b[0], s2.b[1], s1) < 0.1 + EPS) uni(N0 + k, N0 + m);
    }
  }
  for (let k = 0; k < nv.length; k++) {
    ns.forEach((s, m) => { if (ptSeg(nv[k].x, nv[k].y, s) < 0.25 + EPS) uni(N1 + k, N0 + m); });
  }
  const groups = new Map();
  np.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.label);
  });
  if (groups.size === 1) { ok++; if (!quiet) console.log(`${net}: OK`); }
  else {
    bad += groups.size - 1;
    missing.push(net);
    console.log(`${net}: SPLIT into ${[...groups.values()].map((g2) => g2.join('+')).join('  |  ')}`);
  }
}
console.log(`== ${ok}/${nets.length} nets complete, ${bad} missing connections${missing.length ? ' (' + missing.join(', ') + ')' : ''}`);
