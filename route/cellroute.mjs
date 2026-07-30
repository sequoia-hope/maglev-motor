// Turn the cellgen.mjs board into a SINGLE-CELL routing problem: route only
// the centre cell's nets; every other cell is pure obstacle. The cell's bus
// connections terminate on its own seam vias (presented to the router as
// through-hole anchor pins); the neighbours' seam vias are keepouts. What
// comes back is the candidate STAMP for every cell of the board.
//
//   node cellroute.mjs [boardPath] [outDsn]
import { readFileSync, writeFileSync } from 'fs';
import { makeStator, pcbBoardThickness } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize, viaDrill, FAB } from '../src/kicad.js';
import { readBoard, writeDsn } from './mkdsn.mjs';
import { SEAM_SIGNALS } from './cellspec.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

const key = 'amzhex';
const n = 3;
const boardPath = process.argv[2] || 'cellexp.kicad_pcb';
const out = process.argv[3] || 'cellexp.dsn';
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));
cfg.stator.statorSize = n * cfg.stator.coilPitch;

const g = pcbCoilGeometry(cfg);
const pitch = cfg.stator.coilPitch * 1000;
const cellHalf = pitch / 2;
const vSize = viaSize(g, cellHalf);
const N = cfg.stator.pcbLayers, spare = cfg.stator.pcbSpareLayers;
const cuName = (j) => (j === 0 ? 'F.Cu' : j === N - 1 ? 'B.Cu' : `In${j}.Cu`);
const layers = [];
for (let j = N - 1; j >= N - spare; j--) layers.push(cuName(j));

const board = readBoard(boardPath);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const coils = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);

// centre cell + chain order (same recipe as cellgen)
const world = stator.coils.map((c) => ({ wx: c.x * 1000, wy: c.y * 1000 }));
let centre = 0, dBest = 1e9;
world.forEach((c, i) => { const d = Math.hypot(c.wx, c.wy); if (d < dBest) { dBest = d; centre = i; } });
const rowKey = (c) => +c.wy.toFixed(3);
const rowsYs = [...new Set(world.map(rowKey))].sort((a, b) => a - b);
const rowIdx = new Map(rowsYs.map((y, i2) => [y, i2]));
const order = world.map((c, i2) => ({ i: i2, row: rowIdx.get(rowKey(c)), x: c.wx }))
  .sort((a, b) => a.row - b.row || a.x - b.x);
const chainK = new Map(order.map((o, k2) => [o.i, k2]));
const kC = chainK.get(centre);
const cc = coils[centre];

// --- via classification -------------------------------------------------------
// Terminal vias sit under Term pads; seam vias are at the SEAM_SIGNALS offsets.
// The CENTRE cell's own seam vias (its E seam and its W seam) become router
// anchors; every other via is a keepout.
const termAt = new Set();
for (const fp of board.fps) {
  if (fp.lib !== 'Term') continue;
  termAt.add(`${fp.x.toFixed(3)},${fp.y.toFixed(3)}`);
}
const isTerm = (v) => termAt.has(`${v.x.toFixed(3)},${v.y.toFixed(3)}`);

const seamNetOfCentre = new Map();   // "x,y" -> router net name
for (const s of SEAM_SIGNALS) {
  const east = [cc[0] + s.at[0], cc[1] - s.at[1]];
  const west = [cc[0] + s.at[0] - pitch, cc[1] - s.at[1]];
  const nm = s.net === 'DATA' ? null : `${s.net}_C`;
  seamNetOfCentre.set(`${east[0].toFixed(3)},${east[1].toFixed(3)}`, s.net === 'DATA' ? 'DATA_E' : nm);
  seamNetOfCentre.set(`${west[0].toFixed(3)},${west[1].toFixed(3)}`, s.net === 'DATA' ? 'DATA_W' : nm);
}
const anchorPads = [];
const keepVias = [];
for (const v of board.vias) {
  if (isTerm(v)) continue;
  const k2 = `${v.x.toFixed(3)},${v.y.toFixed(3)}`;
  const anchorNet = seamNetOfCentre.get(k2);
  if (anchorNet) anchorPads.push({ x: v.x, y: v.y, dia: v.size, net: anchorNet });
  else keepVias.push(v);
}
const termVias = board.vias.filter(isTerm);
console.log(`anchors ${anchorPads.length} (expect 18), keepouts ${keepVias.length}`);

// --- net overrides for the centre cell ---------------------------------------
// Bus pads of the centre cell's parts -> *_C nets; its coil split into A/B.
const netOverride = new Map();
netOverride.set(`J${centre}.IN|1`, `coil_${centre}_A`);
netOverride.set(`J${centre}.OUT|1`, `coil_${centre}_B`);
// bridge: pad 2 = OUTA -> A, pad 6 = OUTB -> B (SOT23HB convention)
netOverride.set(`U${centre}|2`, `coil_${centre}_A`);
netOverride.set(`U${centre}|6`, `coil_${centre}_B`);
netOverride.set(`U${centre}|3`, 'GND_C');
netOverride.set(`U${centre}|4`, 'VBUS_C');
netOverride.set(`C${centre}|1`, 'VBUS_C');
netOverride.set(`C${centre}|2`, 'GND_C');
// register: bus + chain pads
const srOv = { 1: 'GND_C', 4: 'VLOGIC_C', 6: 'SCLK_C', 8: 'RCLK_C', 10: 'OE_N_C', 12: 'DATA_W', 2: 'DATA_E', 16: 'VLOGIC_C' };
for (const [pd, nm] of Object.entries(srOv)) netOverride.set(`SR${centre}|${pd}`, nm);

// --- stubs (crossover tab keepouts), same as route.mjs -----------------------
const plan = viaPlan(g, g.layers, cellHalf, vSize);
const coilKeepR = g.halfOut + g.trace / 2;
const inHex = (x, y) => {
  let m = -Infinity;
  for (let k2 = 0; k2 < 6; k2++) {
    const a = (k2 * Math.PI) / 3;
    m = Math.max(m, x * Math.cos(a) + y * Math.sin(a));
  }
  return m <= coilKeepR;
};
const stubs = [];
{
  const seen = new Set(), local = [];
  for (const [x0, y0, x1, y1] of [...plan.segments, ...plan.terminals]) {
    const k2 = `${x0.toFixed(4)},${y0.toFixed(4)},${x1.toFixed(4)},${y1.toFixed(4)}`;
    if (seen.has(k2)) continue;
    seen.add(k2);
    if (inHex(x0, y0) && inHex(x1, y1)) continue;
    local.push([x0, y0, x1, y1]);
  }
  for (const [cxm, cym] of coils) {
    for (const [x0, y0, x1, y1] of local) stubs.push([cxm + x0, cym - y0, cxm + x1, cym - y1, g.trace]);
  }
}

const laneNets = ['VBUS_C', 'GND_C', 'VLOGIC_C', 'SCLK_C', 'RCLK_C', 'OE_N_C', 'DATA_W', 'DATA_E', 'SDA_C', 'SCL_C'];
const localNets = [`coil_${centre}_A`, `coil_${centre}_B`, `PWMA_${centre}`, `PWMB_${centre}`];
// LANES=1: stage one -- route only the seam-to-seam bus lanes, nothing local.
// RESTRICT=a,b,...: route exactly these nets (a net-by-net build's one stage).
const onlyNets = (process.env.RESTRICT ? process.env.RESTRICT.split(',')
  : process.env.LANES ? laneNets : [...localNets, ...laneNets]).map((s) => `^${s}$`);

// SES_CARRY=<stage1.ses>: carry a previous stage's routed copper straight from
// the session file (its net names are already the router-local ones), as
// PROTECTED wiring -- router-generated copper carried protected is the one
// combination freerouting 2.2.4 handles (constructed wiring NPEs it, and
// unprotected carry just gets ripped up again).
let carried = [], carriedVias = [];
if (process.env.SES_CARRY) {
  const ses = readFileSync(process.env.SES_CARRY, 'utf8');
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
        carried.push({
          net: name, layer: w[1], width: +w[2] * scale,
          a: [x0 * scale, -y0 * scale], b: [x1 * scale, -y1 * scale],
        });
      }
    }
    for (const v of sbody.matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
      const [x, y] = v[1].trim().split(/\s+/).map(Number);
      carriedVias.push({ x: x * scale, y: -y * scale, net: name });
    }
  }
  console.log(`carrying ${carried.length} segments + ${carriedVias.length} vias from ${process.env.SES_CARRY}`);
}

const innerR = g.halfIn - g.trace / 2;
const rHole = innerR - FAB.minClearance - vSize / 2;
const coilHoleR = Math.max(0, rHole - vSize / 2 - FAB.minClearance);
const routeVia = { name: 'Via_route', dia: vSize, drill: viaDrill(vSize, g.thickness) };

const stats = writeDsn(board, {
  name: 'cellexp_route',
  layers,
  rule: { width: Math.max(FAB.minTrace, 0.1), clearance: FAB.minClearance, edge: FAB.edgeClearance },
  via: routeVia,
  coils, coilKeepR, coilHoleR, keepVias, stubs, termVias, padLayer: 'B.Cu',
  netOverride,
  anchorPads,
  onlyNets,
  carried, carriedVias, protectCarried: carried.length > 0,
  out,
});
console.log(JSON.stringify({ layers, via: routeVia, centre, kC, ...stats }, null, 1));
console.log(`wrote ${out}`);
