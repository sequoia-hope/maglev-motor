// Does the stamp TILE? Not "is it legal where it sits" -- that is what DRC on
// the merged single-quad board answers, and it has answered yes for weeks. This
// asks the different question: if the same copper is laid on every quad of the
// lattice, does a stamp collide with its own neighbours?
//
// The lattice is two pure translations: one quad east (2 cells) and one band
// north (2 rows, which is where the +-p/4 row stagger cancels). So the test is
// the stamp against eight shifted copies of itself, net-aware -- the bus nets
// are global and MAY touch across a seam; anything named per cell may not.
//
//   node tilecheck.mjs <boardKey> <session.ses[,more]>
import { readFileSync } from 'fs';
import { readBoard } from './mkdsn.mjs';
import { makeStator } from '../src/coils.js';
import { FAB } from '../src/kicad.js';

const B = process.argv[2] || 'fabtest';
const sesPaths = (process.argv[3] || `${B}.union.ses`).split(',');
const spec = JSON.parse(readFileSync(`${B}.quads.json`, 'utf8'));
const { quads, centreQuad } = spec;
const board = readBoard(`${B}.kicad_pcb`);

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

// --- the stamp's copper, in board millimetres (same reader as quadclone) ------
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

// --- the lattice: one quad east, one band north ------------------------------
const S = quads[centreQuad];
const org = (q) => coilF[q.cells[0]];
const east = quads.find((q) => q.band === S.band && q.pos === S.pos + 1);
const north = quads.find((q) => q.band === S.band + 1 && q.pos === S.pos);
const A = [org(east)[0] - org(S)[0], org(east)[1] - org(S)[1]];
const Bv = [org(north)[0] - org(S)[0], org(north)[1] - org(S)[1]];
console.log(`lattice: east ${A.map((v) => v.toFixed(4))}  north ${Bv.map((v) => v.toFixed(4))}`);

// --- net identity across the lattice ------------------------------------------
// quadclone's mapNet, generalised: which BOARD net does this stamp net become on
// the quad (i, j) steps away? Global bus nets keep their name everywhere, so two
// stamps' copies of them are the same copper and may touch.
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
    // the chain is per quad: W is this quad's index, E the next one's
    const g = quads.findIndex((q) => q.band === S.band + j && q.pos === S.pos + i);
    return g < 0 ? `DATA_?${i},${j}` : `DATA_${g + (name === 'DATA_E' ? 1 : 0)}`;
  }
  return name;
};

// --- geometry ------------------------------------------------------------------
const CLR = FAB.minClearance;
const VIA = 0.5;                                   // land diameter; drill is smaller
const shift = (p, i, j) => [p[0] + i * A[0] + j * Bv[0], p[1] + i * A[1] + j * Bv[1]];
const segDist = (p, q, r, s) => {                  // segment-to-segment distance
  const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [s[0] - r[0], s[1] - r[1]];
  const rr = [p[0] - r[0], p[1] - r[1]];
  const a = d1[0] ** 2 + d1[1] ** 2, e = d2[0] ** 2 + d2[1] ** 2, f = d2[0] * rr[0] + d2[1] * rr[1];
  let t, u;
  const c = d1[0] * rr[0] + d1[1] * rr[1], b = d1[0] * d2[0] + d1[1] * d2[1];
  const den = a * e - b * b;
  t = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
  u = e > 1e-12 ? (b * t + f) / e : 0;
  if (u < 0) { u = 0; t = Math.min(1, Math.max(0, -c / a)); }
  else if (u > 1) { u = 1; t = Math.min(1, Math.max(0, (b - c) / a)); }
  const c1 = [p[0] + d1[0] * t, p[1] + d1[1] * t], c2 = [r[0] + d2[0] * u, r[1] + d2[1] * u];
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1]);
};
const ptSeg = (px, py, p, q) => {
  const vx = q[0] - p[0], vy = q[1] - p[1];
  const L = vx * vx + vy * vy;
  const t = L > 1e-12 ? Math.min(1, Math.max(0, ((px - p[0]) * vx + (py - p[1]) * vy) / L)) : 0;
  return Math.hypot(px - (p[0] + t * vx), py - (p[1] + t * vy));
};

const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const hits = [];
for (const [i, j] of NB) {
  for (const s of segs) {
    const n0 = mapNet(s.net, 0, 0);
    for (const t of segs) {
      if (t.layer !== s.layer) continue;
      const n1 = mapNet(t.net, i, j);
      if (n1 === n0) continue;                     // same board net: a join, not a clash
      const need = CLR + s.w / 2 + t.w / 2;
      const d = segDist(s.a, s.b, shift(t.a, i, j), shift(t.b, i, j));
      if (d < need - 1e-6) {
        hits.push({ kind: 'track/track', at: [i, j], a: s.net, b: t.net, an: n0, bn: n1,
          layer: s.layer, d: +d.toFixed(4), need: +need.toFixed(4),
          x: +s.a[0].toFixed(3), y: +s.a[1].toFixed(3) });
      }
    }
    for (const v of svias) {                       // a via is on every layer
      const n1 = mapNet(v.net, i, j);
      if (n1 === n0) continue;
      const need = CLR + s.w / 2 + VIA / 2;
      const p = shift([v.x, v.y], i, j);
      const d = ptSeg(p[0], p[1], s.a, s.b);
      if (d < need - 1e-6) {
        hits.push({ kind: 'track/via', at: [i, j], a: s.net, b: v.net, an: n0, bn: n1,
          layer: s.layer, d: +d.toFixed(4), need: +need.toFixed(4),
          x: +p[0].toFixed(3), y: +p[1].toFixed(3) });
      }
    }
  }
}

// one row per (net pair, neighbour), the closest approach
const worst = new Map();
for (const h of hits) {
  const k = `${h.at}|${h.a}|${h.b}|${h.layer}`;
  if (!worst.has(k) || worst.get(k).d > h.d) worst.set(k, h);
}
const rows = [...worst.values()].sort((p, q) => p.d - q.d);
console.log(`\n${segs.length} segments, ${svias.length} vias in the stamp`);
console.log(`${hits.length} pairwise conflicts against the 8 neighbouring stamps` +
            `, ${rows.length} distinct (net pair x neighbour)\n`);
for (const r of rows) {
  console.log(`  [${String(r.at).padEnd(6)}] ${r.layer.padEnd(9)} ` +
    `${r.a.padEnd(11)} vs ${r.b.padEnd(11)} (${r.an} / ${r.bn})  ` +
    `${r.d} < ${r.need}  at ${r.x},${r.y}`);
}
if (!rows.length) console.log('  TILES CLEAN');
process.exit(rows.length ? 1 : 0);
