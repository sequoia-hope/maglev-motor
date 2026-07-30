// CLONE the routed centre quad onto all 42 quads and CONNECT: the shared seam
// vias make horizontally adjacent stamps continuous by construction. Copper
// that would land outside the board outline (the W/E board margins where the
// seam ladder does not exist) is trimmed -- those are the spine-stage feed
// points, not stamp copper. Emits <out>.kicad_pcb ready for DRC.
//   node quadclone.mjs [boardKey] [session]
import { readFileSync, writeFileSync } from 'fs';
import { readBoard } from './mkdsn.mjs';

const B = process.argv[2] || 'quadexp';
const sesPaths = (process.argv[3] || `${B}.staged.ses`).split(',');
const spec = JSON.parse(readFileSync(`${B}.quads.json`, 'utf8'));
const { quads, centreQuad } = spec;
const boardTxt = readFileSync(`${B}.kicad_pcb`, 'utf8');
const board = readBoard(`${B}.kicad_pcb`);

const netOf = new Map();
for (const m of boardTxt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netOf.set(m[2], +m[1]);

// board frame: coil centres (world -> file) recovered exactly as quadgen did
import { makeStator } from '../src/coils.js';
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
if (process.env.TILE) cfg.stator.statorSize = (+process.env.TILE) * cfg.stator.coilPitch;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coilF = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);

// session copper (already in board mm after scaling); several sessions union
// (a staged build leaves locals+power in one session and lanes in another)
const segs = [], svias = [];
for (const sp of sesPaths) {
  const ses = readFileSync(sp, 'utf8');
  const res = ses.match(/\(resolution (\w+) (\d+)\)/);
  const scale = ((res ? res[1] : 'um') === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
  const routes = ses.slice(ses.indexOf('(network_out'));
  for (const nm of routes.matchAll(/\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g)) {
    const name = nm[1], sbody = nm[2];
    for (const w of sbody.matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
      const nums = w[3].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 3 < nums.length; i += 2) {
        const [x0, y0, x1, y1] = [nums[i], nums[i + 1], nums[i + 2], nums[i + 3]];
        if (x0 === x1 && y0 === y1) continue;
        segs.push({ net: name, layer: w[1], width: +w[2] * scale, a: [x0 * scale, -y0 * scale], b: [x1 * scale, -y1 * scale] });
      }
    }
    for (const v of sbody.matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
      const [x, y] = v[1].trim().split(/\s+/).map(Number);
      svias.push({ net: name, x: x * scale, y: -y * scale });
    }
  }
}
console.log(`stamp: ${segs.length} segments, ${svias.length} vias`);

// point-in-outline (the outline loop from gr_lines; chain them)
const loop = (() => {
  const key = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
  const next = new Map();
  for (const [x0, y0, x1, y1] of board.outline) next.set(key(x0, y0), [x1, y1]);
  const start = [board.outline[0][0], board.outline[0][1]];
  const L = [start];
  let cur = start;
  for (let i = 0; i < board.outline.length; i++) {
    const n = next.get(key(cur[0], cur[1]));
    if (!n || (Math.abs(n[0] - start[0]) < 1e-6 && Math.abs(n[1] - start[1]) < 1e-6)) break;
    L.push(n); cur = n;
  }
  return L;
})();
const inside = (x, y) => {
  let odd = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) odd = !odd;
  }
  return odd;
};

// via geometry from the board's own stackup (same rule mkses uses)
const vm = boardTxt.match(/\(via \(at [-\d.]+ [-\d.]+\) \(size ([\d.]+)\) \(drill ([\d.]+)\)/);
const viaDia = +vm[1], viaDrill = +vm[2];

const S = quads[centreQuad];
const srcO = coilF[S.cells[0]];
const f = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));
const out = [];
let placed = 0, trimmed = 0;
for (const [g2, q] of quads.entries()) {
  const dstO = coilF[q.cells[0]];
  const dx = dstO[0] - srcO[0], dy = dstO[1] - srcO[1];
  const mapNet = (name) => {
    let m;
    if ((m = /^coil_(\d+)_[AB]$/.exec(name))) return `coil_${q.cells[S.cells.indexOf(+m[1])]}`;
    if ((m = /^PWM([AB])_(\d+)$/.exec(name))) return `PWM${m[1]}_${q.cells[S.cells.indexOf(+m[2])]}`;
    if (name === 'DATA_W') return `DATA_${g2}`;
    if (name === 'DATA_E') return `DATA_${g2 + 1}`;
    if (name.endsWith('_C')) return name.slice(0, -2);
    return name;
  };
  for (const s of segs) {
    const a = [s.a[0] + dx, s.a[1] + dy], b2 = [s.b[0] + dx, s.b[1] + dy];
    if (!inside(a[0], a[1]) || !inside(b2[0], b2[1])) { trimmed++; continue; }
    const nn = netOf.get(mapNet(s.net));
    if (nn == null) { trimmed++; continue; }
    out.push(`  (segment (start ${f(a[0])} ${f(a[1])}) (end ${f(b2[0])} ${f(b2[1])}) (width ${f(s.width)}) (layer "${s.layer}") (net ${nn}))`);
    placed++;
  }
  for (const v of svias.map((v2) => ({ ...v2, x: v2.x + dx, y: v2.y + dy }))) {
    if (!inside(v.x, v.y)) { trimmed++; continue; }
    const nn = netOf.get(mapNet(v.net));
    if (nn == null) { trimmed++; continue; }
    out.push(`  (via (at ${f(v.x)} ${f(v.y)}) (size ${viaDia}) (drill ${viaDrill}) (layers "F.Cu" "B.Cu") (net ${nn}))`);
    placed++;
  }
}
console.log(`cloned to ${quads.length} quads: ${placed} items placed, ${trimmed} trimmed (board edge / unknown net)`);
const cut = boardTxt.lastIndexOf('\n)');
writeFileSync(`${B}.full.kicad_pcb`, boardTxt.slice(0, cut) + '\n' + out.join('\n') + boardTxt.slice(cut));
console.log(`wrote ${B}.full.kicad_pcb`);
