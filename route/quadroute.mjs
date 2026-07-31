// The CENTRE-QUAD routing problem from a quadgen.mjs board: route one quad's
// nets (its four cells' locals, its register, its bus taps, its through-lanes),
// everything else is obstacle. Seam vias on the quad's boundary AND internal
// seams become router anchor pins; all other vias are keepouts. Writes
// <out>.pins.json so checkses.mjs can verify the session geometrically.
//   node quadroute.mjs [board] [outDsn]     (env: RESTRICT, SES_CARRY, LANES)
import { readFileSync, writeFileSync } from 'fs';
import { makeStator } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize, viaDrill, FAB } from '../src/kicad.js';
import { readBoard, writeDsn } from './mkdsn.mjs';
import { SEAM_SIGNALS } from './cellspec.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
if (process.env.TILE) cfg.stator.statorSize = (+process.env.TILE) * cfg.stator.coilPitch;

const boardPath = process.argv[2] || 'quadexp.kicad_pcb';
const out = process.argv[3] || 'quadexp.dsn';
const spec = JSON.parse(readFileSync(boardPath.replace(/\.kicad_pcb$/, '.quads.json'), 'utf8'));
const { quads, centreQuad } = spec;

const g = pcbCoilGeometry(cfg);
const pitch = cfg.stator.coilPitch * 1000;
const cellHalf = pitch / 2;
const vSize = viaSize(g, cellHalf);
const N = cfg.stator.pcbLayers, spare = cfg.stator.pcbSpareLayers;
const cuName = (j) => (j === 0 ? 'F.Cu' : j === N - 1 ? 'B.Cu' : `In${j}.Cu`);
const layers = [];
for (let j = N - 1; j >= N - spare; j--) layers.push(cuName(j));
// Winding-layer FABRIC: extra routing layers through the seam gutters. The
// router gets them declared WITH the truth about their copper -- the hex
// annulus and that layer's tabs become wire keepouts below -- or it would
// happily route through the winding it cannot see.
const FABRIC = (process.env.FABRIC_LAYERS || '').split(',').filter(Boolean);
layers.push(...FABRIC);

const board = readBoard(boardPath);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const coils = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);

const Q = quads[centreQuad];
const qcells = Q.cells;                          // [SW, SE, NW, NE]
console.log(`centre quad ${centreQuad}: cells ${qcells.join(',')}`);

// --- seam via classification -------------------------------------------------
// A seam east of cell i carries vias at coils[i] + SEAM_SIGNALS offsets. For
// the centre quad: seams INSIDE or ON THE BOUNDARY of the quad become anchors
// with quad-local nets; every other seam via is a keepout.
const westOf = new Map();
stator.coils.forEach((c, i) => {
  const j = stator.coils.findIndex((d) => Math.abs(d.x * 1000 - c.x * 1000 + pitch) < 0.01 && Math.abs(d.y - c.y) < 0.01);
  if (j >= 0) westOf.set(i, j);                  // j is west neighbour of i
});
const inQuad = new Set(qcells);
const anchorNetAt = new Map();                   // "x,y" -> net
for (const i of stator.coils.keys()) {
  const e = stator.coils.findIndex((d) => Math.abs(d.x * 1000 - stator.coils[i].x * 1000 - pitch) < 0.01 && Math.abs(d.y - stator.coils[i].y) < 0.01);
  if (e < 0) continue;
  const touches = inQuad.has(i) || inQuad.has(e);
  if (!touches) continue;
  for (const s of SEAM_SIGNALS) {
    const fx = coils[i][0] + s.at[0], fy = coils[i][1] - s.at[1];
    let nm = `${s.net}_C`;
    if (s.net === 'DATA') {
      // only chain seams have a DATA via; name by direction relative to the quad
      if (inQuad.has(i) && inQuad.has(e)) continue;      // no DATA inside a quad
      nm = inQuad.has(e) ? 'DATA_W' : 'DATA_E';
    }
    anchorNetAt.set(`${fx.toFixed(3)},${fy.toFixed(3)}`, nm);
  }
}
// Coil terminal vias: the Term SMT pads are gone (the via IS the terminal --
// user call, 2026-07-31), so terminals are located from the via plan itself.
// termVias[0] is the IN lead (layer 0's start), [1] the OUT (last layer's
// end); route.mjs convention maps IN -> coil_i_A, OUT -> coil_i_B.
const planEarly = viaPlan(g, g.layers, cellHalf, vSize, spec.viaPlanOpts || {});
const termNetAt = new Map();                     // "x,y" -> quad coil net (A/B)
const termAt = new Set();                        // every cell's terminal spots
for (const [i, [cxm, cym]] of coils.entries()) {
  planEarly.termVias.forEach((tv, k) => {
    const key = `${(cxm + tv.p[0]).toFixed(3)},${(cym + tv.p[1]).toFixed(3)}`;
    termAt.add(key);
    if (inQuad.has(i)) termNetAt.set(key, `coil_${i}_${k === 0 ? 'A' : 'B'}`);
  });
}
const isTerm = (v) => termAt.has(`${v.x.toFixed(3)},${v.y.toFixed(3)}`);
// DONE_NETS: lane nets whose seam vias are already joined by CONSTRUCTED
// copper (lanegen.mjs, carried via SES_CARRY): their anchors are obstacles,
// not router pins -- presenting them as pins re-creates freerouting's
// phantom-unrouted bookkeeping on nets it must not touch.
// TAPS: chosen via barrels that serve as the register drops' layer portals.
// Each gets a B.Cu pad (the router lands the SR fanout on the via's own
// land) and keepouts on the other electronics layer only.
const doneNets = new Set((process.env.DONE_NETS || '').split(',').filter(Boolean));
const taps = process.env.TAPS ? JSON.parse(readFileSync(process.env.TAPS, 'utf8')) : [];
const tapAt = (x, y) => taps.find((t) => Math.hypot(t.x - x, t.y - y) < 0.02);
const anchorPads = [], keepVias = [], tapVias = [];
for (const v of board.vias) {
  if (isTerm(v)) {
    // a quad cell's terminal via is the coil's ROUTER PIN (B.Cu, where the
    // bridge pads live); every other cell's is a plain obstacle on all layers
    const tn = termNetAt.get(`${v.x.toFixed(3)},${v.y.toFixed(3)}`);
    if (tn) anchorPads.push({ x: v.x, y: v.y, dia: v.size, net: tn, layer: 'B.Cu' });
    else keepVias.push(v);
    continue;
  }
  const nm = anchorNetAt.get(`${v.x.toFixed(3)},${v.y.toFixed(3)}`);
  if (nm && tapAt(v.x, v.y)) tapVias.push(v);
  else if (nm && !doneNets.has(nm)) anchorPads.push({ x: v.x, y: v.y, dia: v.size, net: nm, layer: 'In12.Cu' });
  else keepVias.push(v);
}
// barrel taps of a DONE net are joined to each other by the constructed lane
// itself (lanegen verifies every anchor touches its copper) -- record that so
// checkses does not report the lane's own span as a routing failure. Stub-end
// taps stand alone: the router genuinely owes them a connection.
for (const t of taps) {
  anchorPads.push({
    x: t.x, y: t.y, dia: t.dia || vSize, net: t.net, layer: 'B.Cu',
    join: t.kind !== 'stub' && doneNets.has(t.net) ? t.net : undefined,
  });
}
const termVias = tapVias;                        // barrels whose B.Cu land is a pad the router uses
console.log(`anchors ${anchorPads.length} (${taps.length} taps), keepouts ${keepVias.length}`);

// --- net overrides -----------------------------------------------------------
const doneNetsEarly = new Set((process.env.DONE_NETS || '').split(',').filter(Boolean));
const ov = (k, nm) => { if (!(doneNetsEarly.has(nm) && !k.startsWith('SR'))) netOverride.set(k, nm); };
const netOverride = new Map();
for (const ci of qcells) {
  // the coil halves' OTHER pins are the terminal-via anchor pads (see the
  // isTerm branch above) -- the J footprints no longer exist
  netOverride.set(`U${ci}|2`, `coil_${ci}_A`);
  netOverride.set(`U${ci}|6`, `coil_${ci}_B`);
  ov(`U${ci}|3`, 'GND_C');
  ov(`U${ci}|4`, 'VBUS_C');
  ov(`C${ci}|1`, 'VBUS_C');
  ov(`C${ci}|2`, 'GND_C');
}
for (const [pd, nm] of Object.entries({ 1: 'GND_C', 4: 'VLOGIC_C', 6: 'SCLK_C', 8: 'RCLK_C', 10: 'OE_N_C', 12: 'DATA_W', 2: 'DATA_E', 16: 'VLOGIC_CE' })) {
  netOverride.set(`SR${centreQuad}|${pd}`, nm);
}
// SR_STUBBED: register pads whose escape is CONSTRUCTED copper (lanegen's
// nested fanout). The pad leaves the routing netlist -- its net's router pin
// is the stub-end tap pad instead -- and becomes a plain obstacle, so the
// router never has to thread the 0.5 mm fan. Stage pins then measure the
// router's actual job (tap -> destinations); pad -> tap is the constructor's.
const srStubbed = new Set((process.env.SR_STUBBED || '').split(',').filter(Boolean));
for (const pd of srStubbed) netOverride.set(`SR${centreQuad}|${pd}`, `DONE_SRPAD_${pd}`);

// --- stubs (crossover tab keepouts) ------------------------------------------
const plan = viaPlan(g, g.layers, cellHalf, vSize, spec.viaPlanOpts || {});
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
const localNets = qcells.flatMap((ci) => [`coil_${ci}_A`, `coil_${ci}_B`, `PWMA_${ci}`, `PWMB_${ci}`]);
const onlyNets = (process.env.RESTRICT ? process.env.RESTRICT.split(',')
  : process.env.LANES ? laneNets : [...localNets, ...laneNets]).map((s) => `^${s}$`);

let carried = [], carriedVias = [];
// CARRY_SKIP_NETS: nets to DROP from the carried copper -- a cleanup stage
// re-routing a net must not see that net's own failed fragments as keepouts.
const carrySkip = new Set((process.env.CARRY_SKIP_NETS || '').split(',').filter(Boolean));
for (const sesFile of (process.env.SES_CARRY || '').split(',').filter(Boolean)) {
  const ses = readFileSync(sesFile, 'utf8');
  const res = ses.match(/\(resolution (\w+) (\d+)\)/);
  const scale = ((res ? res[1] : 'um') === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
  const routes = ses.slice(ses.indexOf('(network_out'));
  for (const nm of routes.matchAll(/\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g)) {
    const name = nm[1], sbody = nm[2];
    if (carrySkip.has(name)) continue;
    for (const w of sbody.matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
      const nums = w[3].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 3 < nums.length; i += 2) {
        const [x0, y0, x1, y1] = [nums[i], nums[i + 1], nums[i + 2], nums[i + 3]];
        if (x0 === x1 && y0 === y1) continue;
        carried.push({ net: name, layer: w[1], width: +w[2] * scale, a: [x0 * scale, -y0 * scale], b: [x1 * scale, -y1 * scale] });
      }
    }
    for (const v of sbody.matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
      const [x, y] = v[1].trim().split(/\s+/).map(Number);
      carriedVias.push({ x: x * scale, y: -y * scale, net: name });
    }
  }
  // Merge collinear chains: freerouting's carried-wiring hang scales with
  // FRAGMENT COUNT (see buses.mjs: polylines must be decimated or it
  // stack-overflows / spins at 200% CPU with zero passes). Long straight lane
  // runs come back as dozens of 2-point pieces; fuse them.
  const key = (p2) => `${p2[0].toFixed(4)},${p2[1].toFixed(4)}`;
  let fused = 1;
  while (fused) {
    fused = 0;
    const byEnd = new Map();
    for (const [i, t] of carried.entries()) {
      for (const p2 of [t.a, t.b]) {
        const k2 = `${t.net}|${t.layer}|${key(p2)}`;
        if (!byEnd.has(k2)) byEnd.set(k2, []);
        byEnd.get(k2).push(i);
      }
    }
    const dead = new Set();
    for (const [i, t] of carried.entries()) {
      if (dead.has(i)) continue;
      for (const p2 of [t.b]) {
        const k2 = `${t.net}|${t.layer}|${key(p2)}`;
        const cands = (byEnd.get(k2) || []).filter((j) => j !== i && !dead.has(j));
        if (cands.length !== 1) continue;         // junction or dead end: keep
        const j = cands[0], u = carried[j];
        const uo = key(u.a) === key(p2) ? u.b : u.a;
        const d1 = [t.b[0] - t.a[0], t.b[1] - t.a[1]];
        const d2v = [uo[0] - t.b[0], uo[1] - t.b[1]];
        const cross = d1[0] * d2v[1] - d1[1] * d2v[0];
        const dot = d1[0] * d2v[0] + d1[1] * d2v[1];
        if (Math.abs(cross) > 1e-4 * Math.hypot(...d1) * Math.hypot(...d2v) || dot <= 0) continue;
        t.b = uo;
        dead.add(j);
        fused++;
      }
    }
    if (dead.size) carried = carried.filter((_, i) => !dead.has(i));
  }
  console.log(`carrying ${carried.length} segments (after collinear fuse) + ${carriedVias.length} vias`);
}
// CARRY_AS_KEEPOUT=1: earlier stages' copper becomes obstacles, not wiring --
// the protected-carry hang does not apply to keepouts. The stage's own nets
// then must not include the carried ones (pass RESTRICT accordingly).
let copperKeepouts = [];
if (process.env.CARRY_AS_KEEPOUT && carried.length) {
  // Trim carried-copper keepouts around tap pads: a stub ends ON its tap, and
  // an untrimmed keepout (grown by clearance in mkdsn) would swallow the pad
  // and make the net unroutable. Ending the keepout at tapR + clearance +
  // half-width leaves the pad clear while the uncovered stub sliver stays
  // inside the pad's own clearance exclusion -- no foreign copper can reach it.
  const trimR = (t2) => (t2.dia || vSize) / 2 + FAB.minClearance + 0.05;
  const trimEnd = (near, far, t2) => {
    // smallest move along near->far putting the point at exactly trimR of the tap
    const R = trimR(t2);
    const dx = far[0] - near[0], dy = far[1] - near[1];
    const fx = near[0] - t2.x, fy = near[1] - t2.y;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - R * R;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;                    // segment never leaves the circle
    const s2 = (-b + Math.sqrt(disc)) / (2 * a);
    if (s2 <= 0 || s2 >= 1) return null;
    return [near[0] + dx * s2, near[1] + dy * s2];
  };
  let trims = 0;
  carried = carried.flatMap((t) => {
    for (const t2 of taps) {
      const R = trimR(t2);
      const dA = Math.hypot(t.a[0] - t2.x, t.a[1] - t2.y), dB = Math.hypot(t.b[0] - t2.x, t.b[1] - t2.y);
      if (dA >= R && dB >= R) continue;
      trims++;
      if (dA < R && dB < R) return [];            // fully inside: drop
      const [near, far] = dA < R ? [t.a, t.b] : [t.b, t.a];
      const cut = trimEnd(near, far, t2);
      if (!cut) return [];
      return [{ ...t, a: cut, b: far }];
    }
    return [t];
  });
  if (trims) console.log(`trimmed ${trims} carried segments at tap pads`);
  copperKeepouts = [
    ...carried.map((t) => ({ layer: t.layer, seg: [t.a[0], t.a[1], t.b[0], t.b[1], t.width] })),
    // a carried via that is also a TAP keeps its B.Cu land free: that is the
    // pad the router must reach (the constructed DATA_E portal, for one)
    ...carriedVias.flatMap((v) => layers
      .filter((ln) => !(ln === 'B.Cu' && tapAt(v.x, v.y)))
      .map((ln) => ({ layer: ln, circle: { x: v.x, y: v.y, dia: vSize } }))),
  ];
  carried = [];
  carriedVias = [];
  console.log(`carry converted to ${copperKeepouts.length} copper keepouts`);
}

// pins.json for the geometric check
{
  const pins = [];
  for (const [k2, nm] of netOverride) {
    const [ref, pd] = k2.split('|');
    // a DONE net's part taps are the constructor's job (lanegen verifies the
    // comb touches them); the stage only answers for the register drop
    if (doneNets.has(nm) && !ref.startsWith('SR')) continue;
    if (nm.startsWith('DONE_SRPAD_')) continue;   // constructed fanout covers it
    const fp = board.fps.find((f2) => f2.ref === ref);
    const p2 = fp && fp.pads.find((q) => q.name === pd);
    if (p2) pins.push({ net: nm, x: fp.x + p2.dx, y: fp.y + p2.dy, label: `${ref}.${pd}`, w: p2.w, h: p2.h });
  }
  for (const ci of qcells) {
    const fp = board.fps.find((f2) => f2.ref === `SR${centreQuad}`);
    void fp;
  }
  // PWM pads keep their board nets: add both ends
  for (const ci of qcells) {
    for (const [ref, pd, nm] of [[`U${ci}`, '1', `PWMA_${ci}`], [`U${ci}`, '5', `PWMB_${ci}`]]) {
      const fp = board.fps.find((f2) => f2.ref === ref);
      const p2 = fp && fp.pads.find((q) => q.name === pd);
      if (p2) pins.push({ net: nm, x: fp.x + p2.dx, y: fp.y + p2.dy, label: `${ref}.${pd}`, w: p2.w, h: p2.h });
    }
  }
  const srf = board.fps.find((f2) => f2.ref === `SR${centreQuad}`);
  if (srf) for (const p2 of srf.pads) {
    if (srStubbed.has(p2.name)) continue;         // constructed fanout covers it
    if (/^PWM/.test(p2.netName)) pins.push({ net: p2.netName, x: srf.x + p2.dx, y: srf.y + p2.dy, label: `SR.${p2.name}`, w: p2.w, h: p2.h });
  }
  for (const ap of anchorPads) pins.push({ net: ap.net, x: ap.x, y: ap.y, label: `A:${ap.net}@${ap.x.toFixed(1)}`, w: ap.dia, h: ap.dia, join: ap.join });
  writeFileSync(out.replace(/\.dsn$/, '.pins.json'), JSON.stringify(pins, null, 1));
}

const innerR = g.halfIn - g.trace / 2;
const rHole = innerR - FAB.minClearance - vSize / 2;
const coilHoleR = Math.max(0, rHole - vSize - FAB.minClearance);
const routeVia = { name: 'Via_route', dia: vSize, drill: viaDrill(vSize, g.thickness) };
// fabric wire keepouts: per fabric layer, every coil's winding annulus (as
// six pre-grown trapezoids -- specctra polygons have no holes) plus that
// layer's crossover/terminal tabs
if (FABRIC.length) {
  const grow = FAB.minClearance;
  const cos30 = Math.cos(Math.PI / 6);
  const innerRW = g.halfIn - g.trace / 2;
  const RoW = (coilKeepR + grow) / cos30;
  const RiW = Math.max(0.1, (innerRW - grow)) / cos30;
  const hexPtW = (c, R, k) => {
    const a = (k * Math.PI) / 3 + Math.PI / 6;
    return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
  };
  const nameOfIdx = (j) => (j === 0 ? 'F.Cu' : `In${j}.Cu`);
  for (const c of coils) {
    for (let k = 0; k < 6; k++) {
      const q = [hexPtW(c, RiW, k), hexPtW(c, RoW, k), hexPtW(c, RoW, k + 1), hexPtW(c, RiW, k + 1)];
      q.push(q[0]);
      for (const ln of FABRIC) copperKeepouts.push({ layer: ln, poly: q });
    }
  }
  for (const [cxm, cym] of coils) {
    for (const t of [...plan.segments, ...plan.terminals]) {
      const ln = nameOfIdx(t[4]);
      if (!FABRIC.includes(ln)) continue;
      copperKeepouts.push({ layer: ln, seg: [cxm + t[0], cym + t[1], cxm + t[2], cym + t[3], g.trace] });
    }
  }
  console.log(`fabric: ${FABRIC.join(',')} declared with winding keepouts`);
}

const stats = writeDsn(board, {
  name: 'quad_route',
  layers,
  rule: { width: Math.max(FAB.minTrace, 0.1), clearance: FAB.minClearance, edge: FAB.edgeClearance },
  via: routeVia,
  coils, coilKeepR, coilHoleR, keepVias, stubs, termVias, padLayer: 'B.Cu',
  netOverride, anchorPads, onlyNets,
  carried, carriedVias, protectCarried: carried.length > 0,
  copperKeepouts,
  out,
});
console.log(JSON.stringify({ centreQuad, ...stats }, null, 1));
console.log(`wrote ${out}`);
