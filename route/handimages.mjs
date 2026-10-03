// Append the EIGHT neighbouring stamps' copper to a board file, as real tracks
// on the neighbours' own board nets. This is the hand-routing safety net: the
// periodic image walls that killed every A* corridor (see tilecheck.mjs, which
// checks exactly this geometry) become visible copper in pcbnew, so live DRC
// and the router's shove see them while you draw.
//
// The images are REFERENCE copper: handlock.py locks them (everything that is
// not the centre stamp's own ses copper gets locked), and handses.py ignores
// locked copper on extraction. They are exact translated copies of the stamp
// ses with quadclone's net renaming, so "clean against the images" and "clean
// under tilecheck" are the same statement -- except self-images of NEW hand
// copper, which only exist after ./hand.sh rebuild.
//
//   node handimages.mjs <boardKey> <ses[,more]> <target.kicad_pcb>
import { readFileSync, writeFileSync } from 'fs';
import { readBoard } from './mkdsn.mjs';
import { makeStator } from '../src/coils.js';

const B = process.argv[2] || 'fabtile2';
const sesPaths = (process.argv[3] || `${B}.union.ses`).split(',');
const target = process.argv[4];
if (!target) { console.error('usage: node handimages.mjs <boardKey> <ses[,more]> <target.kicad_pcb>'); process.exit(1); }
const spec = JSON.parse(readFileSync(`${B}.quads.json`, 'utf8'));
const { quads, centreQuad } = spec;
const board = readBoard(`${B}.kicad_pcb`);
const targetTxt = readFileSync(target, 'utf8');

const netOf = new Map();
for (const m of targetTxt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netOf.set(m[2], +m[1]);

// board frame: coil centres (world -> file), recovered exactly as quadgen did
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coilF = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);

// the lattice: one quad east, one band north (identical to tilecheck.mjs)
const S = quads[centreQuad];
const org = (q) => coilF[q.cells[0]];
const east = quads.find((q) => q.band === S.band && q.pos === S.pos + 1);
const north = quads.find((q) => q.band === S.band + 1 && q.pos === S.pos);
const A = [org(east)[0] - org(S)[0], org(east)[1] - org(S)[1]];
const Bv = [org(north)[0] - org(S)[0], org(north)[1] - org(S)[1]];
console.log(`lattice: east ${A.map((v) => v.toFixed(4))}  north ${Bv.map((v) => v.toFixed(4))}`);

// net identity across the lattice: tilecheck's mapNet, resolved to BOARD nets
const GLOBAL = /^(GND|VBUS|VLOGIC|SCLK|RCLK|OE_N|SDA|SCL)(_C[WE]?|_C)?$/;
const cellAt = (cell, i, j) => {
  const col = cell % 12, row = Math.floor(cell / 12);
  const c2 = col + 2 * i, r2 = row + 2 * j;
  return (c2 < 0 || c2 > 11 || r2 < 0 || r2 > 13) ? null : r2 * 12 + c2;
};
const mapNet = (name, i, j) => {
  let m;
  if (GLOBAL.test(name)) return name.replace(/_C[WE]?$/, '');
  if ((m = /^coil_(\d+)_[AB]$/.exec(name))) return `coil_${cellAt(+m[1], i, j)}`;
  if ((m = /^PWM([AB])_(\d+)$/.exec(name))) return `PWM${m[1]}_${cellAt(+m[2], i, j)}`;
  if (name === 'DATA_W' || name === 'DATA_E') {
    const g = quads.findIndex((q) => q.band === S.band + j && q.pos === S.pos + i);
    return g < 0 ? null : `DATA_${g + (name === 'DATA_E' ? 1 : 0)}`;
  }
  return name;
};

// stamp copper from the ses (board mm), same reader as tilecheck/quadclone
const segs = [], svias = [];
for (const sp of sesPaths) {
  const ses = readFileSync(sp, 'utf8');
  const res = ses.match(/\(resolution (\w+) (\d+)\)/);
  const scale = ((res ? res[1] : 'um') === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
  const routes = ses.slice(ses.indexOf('(network_out'));
  for (const nm of routes.matchAll(/\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g)) {
    const name = nm[1];
    for (const w of nm[2].matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
      const n = w[3].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 3 < n.length; i += 2) {
        if (n[i] === n[i + 2] && n[i + 1] === n[i + 3]) continue;
        segs.push({ net: name, layer: w[1], w: +w[2] * scale,
          a: [n[i] * scale, -n[i + 1] * scale], b: [n[i + 2] * scale, -n[i + 3] * scale] });
      }
    }
    for (const v of nm[2].matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
      const [x, y] = v[1].trim().split(/\s+/).map(Number);
      svias.push({ net: name, x: x * scale, y: -y * scale });
    }
  }
}
console.log(`stamp: ${segs.length} segments, ${svias.length} vias`);

// point-in-outline trim, as quadclone (the neighbours are interior, but the
// trim keeps this correct if the centre quad ever moves)
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

const vm = targetTxt.match(/\(via \(at [-\d.]+ [-\d.]+\) \(size ([\d.]+)\) \(drill ([\d.]+)\)/);
const viaDia = +vm[1], viaDrill = +vm[2];

const f = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const out = [];
let placed = 0, trimmed = 0;
for (const [i, j] of NB) {
  const dx = i * A[0] + j * Bv[0], dy = i * A[1] + j * Bv[1];
  for (const s of segs) {
    const a = [s.a[0] + dx, s.a[1] + dy], b2 = [s.b[0] + dx, s.b[1] + dy];
    if (!inside(a[0], a[1]) || !inside(b2[0], b2[1])) { trimmed++; continue; }
    const nn = netOf.get(mapNet(s.net, i, j));
    if (nn == null) { trimmed++; continue; }
    out.push(`  (segment (start ${f(a[0])} ${f(a[1])}) (end ${f(b2[0])} ${f(b2[1])}) (width ${f(s.w)}) (layer "${s.layer}") (net ${nn}))`);
    placed++;
  }
  for (const v of svias) {
    const x = v.x + dx, y = v.y + dy;
    if (!inside(x, y)) { trimmed++; continue; }
    const nn = netOf.get(mapNet(v.net, i, j));
    if (nn == null) { trimmed++; continue; }
    out.push(`  (via (at ${f(x)} ${f(y)}) (size ${viaDia}) (drill ${viaDrill}) (layers "F.Cu" "B.Cu") (net ${nn}))`);
    placed++;
  }
}
console.log(`images on 8 neighbours: ${placed} items placed, ${trimmed} trimmed (board edge / off-board net)`);
const cut = targetTxt.lastIndexOf('\n)');
writeFileSync(target, targetTxt.slice(0, cut) + '\n' + out.join('\n') + targetTxt.slice(cut));
console.log(`wrote ${target}`);
