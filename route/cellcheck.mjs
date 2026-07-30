// Which of the centre cell's connections are actually complete in a routed
// session? Builds the connectivity graph the router's copper implies -- pads,
// anchor vias, segments, routing vias -- and reports each net's islands.
//   node cellcheck.mjs <board.kicad_pcb> <session.ses>
import { readFileSync } from 'fs';
import { makeStator } from '../src/coils.js';
import { viaSize, pcbCoilGeometry } from '../src/kicad.js';
import { readBoard } from './mkdsn.mjs';
import { SEAM_SIGNALS } from './cellspec.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
cfg.stator.statorSize = 3 * cfg.stator.coilPitch;

const board = readBoard(process.argv[2] || 'sw_c3.kicad_pcb');
const ses = readFileSync(process.argv[3] || 'sw_c3_try1.ses', 'utf8');

let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const pitch = cfg.stator.coilPitch * 1000;
let centre = 0, dB = 1e9;
stator.coils.forEach((c, i) => { const d = Math.hypot(c.x, c.y); if (d < dB) { dB = d; centre = i; } });
const cc = [cx0 + stator.coils[centre].x * 1000, cy0 - stator.coils[centre].y * 1000];

// centre-cell pins, by router-local net name
const pins = [];   // {net, x, y, label}
const add = (ref, padName, net) => {
  const fp = board.fps.find((f) => f.ref === ref);
  const pd = fp && fp.pads.find((p) => p.name === padName);
  if (pd) pins.push({ net, x: fp.x + pd.dx, y: fp.y + pd.dy, label: `${ref}.${padName}` });
};
add(`J${centre}.IN`, '1', `coil_${centre}_A`);
add(`J${centre}.OUT`, '1', `coil_${centre}_B`);
add(`U${centre}`, '2', `coil_${centre}_A`);
add(`U${centre}`, '6', `coil_${centre}_B`);
add(`U${centre}`, '1', `PWMA_${centre}`);
add(`U${centre}`, '5', `PWMB_${centre}`);
add(`U${centre}`, '3', 'GND_C');
add(`U${centre}`, '4', 'VBUS_C');
add(`C${centre}`, '1', 'VBUS_C');
add(`C${centre}`, '2', 'GND_C');
for (const [pd, nm] of Object.entries({ 1: 'GND_C', 4: 'VLOGIC_C', 6: 'SCLK_C', 8: 'RCLK_C', 10: 'OE_N_C', 12: 'DATA_W', 2: 'DATA_E', 16: 'VLOGIC_C', 14: `PWMA_${centre}`, 15: `PWMB_${centre}` })) {
  add(`SR${centre}`, pd, nm);
}
for (const s of SEAM_SIGNALS) {
  const nm = s.net === 'DATA' ? null : `${s.net}_C`;
  pins.push({ net: s.net === 'DATA' ? 'DATA_E' : nm, x: cc[0] + s.at[0], y: cc[1] - s.at[1], label: `E:${s.net}` });
  pins.push({ net: s.net === 'DATA' ? 'DATA_W' : nm, x: cc[0] + s.at[0] - pitch, y: cc[1] - s.at[1], label: `W:${s.net}` });
}

// session copper
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

// Union-find per net. Joins: a segment joins its own endpoints; two items join
// when a point of one lies on the copper of the other -- point-in-pad (real
// pad extent + a hair), point-on-segment (its half-width + a hair), or
// point-near-via (land radius). This is a connectivity model, not a DRC.
const EPS = 0.06;
const ptSeg = (px, py, s) => {
  const vx = s.b[0] - s.a[0], vy = s.b[1] - s.a[1];
  const L = vx * vx + vy * vy;
  let t = L > 1e-12 ? ((px - s.a[0]) * vx + (py - s.a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.a[0] + t * vx), py - (s.a[1] + t * vy));
};
const padOf = new Map();   // label -> {w,h}
for (const fp of board.fps) for (const pd of fp.pads) padOf.set(`${fp.ref}.${pd.name}`, pd);
const nets = [...new Set(pins.map((p) => p.net))];
for (const net of nets) {
  const np = pins.filter((p) => p.net === net);
  const ns = segs.filter((s) => s.net === net);
  const nv = svias.filter((v) => v.net === net);
  const N0 = np.length, N1 = N0 + ns.length, N2 = N1 + nv.length;
  const parent = Array.from({ length: N2 }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  const padR = (p) => {
    const pd = padOf.get(p.label);
    return pd ? Math.hypot(pd.w, pd.h) / 2 : 0.25;   // anchors: via land
  };
  // pad <-> segment / via
  for (let i = 0; i < N0; i++) {
    const r = padR(np[i]) + EPS;
    ns.forEach((s, k) => { if (ptSeg(np[i].x, np[i].y, s) < r) uni(i, N0 + k); });
    nv.forEach((v, k) => { if (Math.hypot(np[i].x - v.x, np[i].y - v.y) < r + 0.25) uni(i, N1 + k); });
  }
  // segment <-> segment (endpoint on the other's copper)
  for (let k = 0; k < ns.length; k++) {
    for (let m = k + 1; m < ns.length; m++) {
      const s1 = ns[k], s2 = ns[m];
      const touch = ptSeg(s1.a[0], s1.a[1], s2) < 0.1 + EPS || ptSeg(s1.b[0], s1.b[1], s2) < 0.1 + EPS
        || ptSeg(s2.a[0], s2.a[1], s1) < 0.1 + EPS || ptSeg(s2.b[0], s2.b[1], s1) < 0.1 + EPS;
      if (touch) uni(N0 + k, N0 + m);
    }
  }
  // via <-> segment
  for (let k = 0; k < nv.length; k++) {
    ns.forEach((s, m) => { if (ptSeg(nv[k].x, nv[k].y, s) < 0.25 + EPS) uni(N1 + k, N0 + m); });
  }
  const groups = new Map();
  np.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.label);
  });
  const status = groups.size === 1 ? 'OK' : `SPLIT into ${[...groups.values()].map((g) => g.join('+')).join('  |  ')}`;
  console.log(`${net}: ${status}`);
}
