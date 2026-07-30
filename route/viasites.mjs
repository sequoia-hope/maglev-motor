// How many legal through-via SITES does the routing problem actually contain?
// Samples the board on a fine grid and tests each point the way freerouting
// would: outside every via_keepout (coil annulus, stub, crossover via), a full
// clearance plus via radius clear of every pad and every existing via land.
// Then greedily packs vias (respecting via-to-via clearance) to count how many
// could coexist. That number, per cell, is the board's whole layer-change
// budget under plated-through-hole rules.
import { readBoard } from './mkdsn.mjs';
import { readFileSync } from 'fs';

const dsnPath = process.argv[2] || 'exp_base.dsn';
const boardPath = process.argv[3] || 'exp_base.kicad_pcb';
const dsn = readFileSync(dsnPath, 'utf8');
const board = readBoard(boardPath);

// Pull the via + rule numbers from the DSN itself.
const viaDia = +(dsn.match(/\(padstack "Via_route".*?circle \S+ (\d+)/s) || [])[1] / 1000;
const clr = +(dsn.match(/\(clearance (\d+)\)\n/) || [])[1] / 1000;
const width = +(dsn.match(/\(width (\d+)\)/) || [])[1] / 1000;

// Keepout polygons (already grown by one clearance in the DSN).
const keeps = [];
for (const m of dsn.matchAll(/\(via_keepout "[^"]*" \(polygon [^ ]+ 0 ([^)]+)\)\)/g)) {
  const nums = m[1].trim().split(/\s+/).map(Number);
  const poly = [];
  for (let i = 0; i < nums.length; i += 2) poly.push([nums[i] / 1000, -nums[i + 1] / 1000]);
  keeps.push(poly);
}
// Circle keepouts (crossover vias) and path keepouts (stub tabs).
const circles = [];
for (const m of dsn.matchAll(/\(circle [^ ]+ (\d+) (-?\d+) (-?\d+)\)/g)) {
  circles.push([+m[2] / 1000, -m[3] / 1000, +m[1] / 2000]);
}
const paths = [];
const ptSeg = (x, y, [ax, ay, bx, by]) => {
  const vx = bx - ax, vy = by - ay;
  const L = vx * vx + vy * vy;
  let t = L > 1e-12 ? ((x - ax) * vx + (y - ay) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
};
// Dedup (same polygon emitted once per layer).
const seen = new Set();
const polys = keeps.filter((p) => {
  const k = p.map((q) => q.map((v) => v.toFixed(3)).join(',')).join(';');
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};

// Obstacles a via land must clear: every pad (any net -- a via on net X still
// must clear net X's pads by... 0 actually, same-net is free. Conservative:
// treat only OTHER-net copper as obstacle is net-dependent; for a capacity
// count use all pads, which slightly undercounts) and every existing via land.
const pads = [];
for (const fp of board.fps) for (const pd of fp.pads) {
  const a = ((fp.rot + pd.ang) * Math.PI) / 180;
  // conservative: bounding circle of the pad
  pads.push([fp.x + pd.dx, fp.y + pd.dy, Math.hypot(pd.w, pd.h) / 2]);
}
const lands = board.vias.map((v) => [v.x, v.y, v.size / 2]);

// Board bbox from outline.
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}

const rVia = viaDia / 2;
const step = 0.1;
const legal = [];
for (let x = minX; x <= maxX; x += step) {
  for (let y = minY; y <= maxY; y += step) {
    if (polys.some((p) => inPoly(x, y, p))) continue;
    let ok = true;
    for (const [cx, cy, cr] of circles) if (Math.hypot(x - cx, y - cy) < cr + rVia) { ok = false; break; }
    if (ok) for (const s of paths) if (ptSeg(x, y, s) < s[4] + rVia) { ok = false; break; }
    for (const [px, py, pr] of pads) if (Math.hypot(x - px, y - py) < pr + rVia + clr) { ok = false; break; }
    if (ok) for (const [vx, vy, vr] of lands) if (Math.hypot(x - vx, y - vy) < vr + rVia + clr) { ok = false; break; }
    // rough edge margin
    if (ok && (x - minX < 1 || maxX - x < 1 || y - minY < 1 || maxY - y < 1)) ok = false;
    if (ok) legal.push([x, y]);
  }
}

// Greedy pack: vias need centre-to-centre >= via + clearance.
const minCC = viaDia + clr;
const packed = [];
for (const [x, y] of legal) {
  if (packed.every(([px, py]) => Math.hypot(x - px, y - py) >= minCC)) packed.push([x, y]);
}
console.log(JSON.stringify({
  viaDia, clr, width,
  keepoutPolys: polys.length,
  legalSamplePoints: legal.length,
  packableVias: packed.length,
  perCell9: +(packed.length / 9).toFixed(1),
}, null, 1));
