// Debug: why does no register placement pass? Rebuild the obstacle field the
// way cellgen does and report the blocker at sample points.
import { readFileSync } from 'fs';
import { FOOTPRINTS, pcbCoilGeometry, viaSize } from '../src/kicad.js';
import { makeStator } from '../src/coils.js';
import { readBoard } from './mkdsn.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
cfg.stator.statorSize = 3 * cfg.stator.coilPitch;

const board = readBoard('cellexp.kicad_pcb');   // has seam vias + SRs? (SRs only if emitted)
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const pitch = cfg.stator.coilPitch * 1000;
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coils = stator.coils.map((c) => ({ fx: cx0 + c.x * 1000, fy: cy0 - c.y * 1000, wx: c.x * 1000, wy: c.y * 1000 }));
let centre = 0, dB = 1e9;
stator.coils.forEach((c, i) => { const d = Math.hypot(c.x, c.y); if (d < dB) { dB = d; centre = i; } });
const cc = coils[centre];

const discs = [];
for (const v of board.vias) {
  const dx = v.x - cc.fx, dy = -(v.y - cc.fy);
  if (Math.hypot(dx, dy) < pitch * 1.6) discs.push({ x: dx, y: dy, r: v.size / 2, tag: `via@${dx.toFixed(1)},${dy.toFixed(1)}` });
}
const rects = [], bodies = [];
for (const fp of board.fps) {
  if (fp.lib === 'SR595Q') continue;
  const dx = fp.x - cc.fx, dy = -(fp.y - cc.fy);
  if (Math.hypot(dx, dy) > pitch * 1.6) continue;
  for (const pd of fp.pads) {
    rects.push({ cx: fp.x + pd.dx - cc.fx, cy: -(fp.y + pd.dy - cc.fy), w: pd.w, h: pd.h, ang: (pd.ang * Math.PI) / 180, tag: `${fp.ref}.${pd.name}` });
  }
  if (fp.lib === 'SOT23HB') bodies.push({ cx: dx, cy: dy, w: 3.1, h: 1.8, ang: ((fp.pads[0]?.ang ?? 0) * Math.PI) / 180, tag: `${fp.ref}body` });
  if (fp.lib === 'C0402') bodies.push({ cx: dx, cy: dy, w: 1.1, h: 0.6, ang: ((fp.pads[0]?.ang ?? 0) * Math.PI) / 180, tag: `${fp.ref}body` });
}
console.log(`discs ${discs.length} rects ${rects.length} bodies ${bodies.length}`);

const rot2 = (px, py, c, s) => [px * c - py * s, px * s + py * c];
const rcOverlap = (a, b, grow) => {
  const ca = Math.cos(a.ang), sa = Math.sin(a.ang);
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const qx = dx * ca + dy * sa, qy = -dx * sa + dy * ca;
  const rel = b.ang - a.ang, cr = Math.abs(Math.cos(rel)), sr = Math.abs(Math.sin(rel));
  const qw = b.w / 2 + grow, qh = b.h / 2 + grow;
  return Math.abs(qx) <= a.w / 2 + cr * qw + sr * qh && Math.abs(qy) <= a.h / 2 + sr * qw + cr * qh;
};
const circHit = (r2, cx2, cy2, rad) => {
  const c = Math.cos(r2.ang), s = Math.sin(r2.ang), dx = cx2 - r2.cx, dy = cy2 - r2.cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.max(Math.abs(lx) - r2.w / 2, 0), qy = Math.max(Math.abs(ly) - r2.h / 2, 0);
  return qx * qx + qy * qy <= rad * rad;
};
const fpq = FOOTPRINTS.qfn16;
const why = (rx, ry, rdeg, clr) => {
  const ang = (rdeg * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
  const pads = fpq.pads.map(([px, py, w, h]) => {
    const [qx, qy] = rot2(px, py, c, s);
    return { cx: rx + qx, cy: ry + qy, w, h, ang };
  });
  const bodyR = { cx: rx, cy: ry, w: fpq.body[0], h: fpq.body[1], ang };
  for (const pr of pads) {
    for (const d of discs) if (circHit(pr, d.x, d.y, d.r + clr)) return `pad hits ${d.tag}`;
    for (const r2 of rects) if (rcOverlap(pr, r2, clr)) return `pad hits ${r2.tag}`;
    for (const b of bodies) if (rcOverlap(pr, b, clr)) return `pad hits ${b.tag}`;
  }
  for (const r2 of rects) if (rcOverlap(bodyR, r2, clr)) return `body hits ${r2.tag}`;
  for (const b of bodies) if (rcOverlap(bodyR, b, clr)) return `body hits ${b.tag}`;
  return null;
};
for (const [rx, ry, rdeg] of [[-2.3, -3.4, 60], [-2.0, 0, 90], [-2.4, -0.5, 90], [0, -2.6, 0], [1.5, -1.8, 0], [-1.6, -2.2, 30]]) {
  console.log(rx, ry, rdeg, '->', why(rx, ry, rdeg, 0.09) || 'OK @0.09', '|', why(rx, ry, rdeg, 0.15) || 'OK @0.15');
}
// full sweep count at 0.09
let ok = 0, tot = 0;
for (let rx = -3.2; rx <= 3.2; rx += 0.1) for (let ry = -3.4; ry <= 3.4; ry += 0.1) for (let rdeg = 0; rdeg < 360; rdeg += 30) {
  tot++;
  if (!why(rx, ry, rdeg, 0.09)) ok++;
}
console.log(`sweep: ${ok}/${tot} pass at 0.09`);
