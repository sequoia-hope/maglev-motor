// Drive the whole route: board -> routing DSN -> freerouting -> SES -> merged
// board -> DRC. `node route.mjs <preset> [spareLayers]`.
import { readFileSync, writeFileSync } from 'fs';
import { makeStator, pcbBoardThickness } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize, viaDrill, FAB, BRIDGE_OUT_PADS } from '../src/kicad.js';
import { readBoard, writeDsn } from './mkdsn.mjs';
import { makeField, prewire } from './prewire.mjs';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

const key = process.argv[2] || 'amzhex';
const boardPath = process.argv[3] || `${key}.kicad_pcb`;
// `--tile n` mirrors buildTile(): the same coils on an n-by-n board, for
// iterating on the router without paying for 168 cells every time.
const tileArg = process.argv.find((a) => a.startsWith('--tile='));
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));
if (cfg.stator.pcbSpareLayers == null) cfg.stator.pcbSpareLayers = 0;
if (process.env.SPARE) cfg.stator.pcbSpareLayers = +process.env.SPARE;
if (process.env.LAYERS) cfg.stator.pcbLayers = +process.env.LAYERS;
if (process.env.FILL) cfg.stator.coilFill = +process.env.FILL;
if (process.env.INNER) cfg.stator.pcbInnerFrac = +process.env.INNER;  // PCB_INNER_FRAC override
if (tileArg) cfg.stator.statorSize = (+tileArg.split('=')[1]) * cfg.stator.coilPitch;

const g = pcbCoilGeometry(cfg);
const cellHalf = cfg.stator.coilPitch * 1000 / 2;
const vSize = viaSize(g, cellHalf);

// Which layers may the router use? The spare ones -- the electronics layers the
// winding was kept off. Named the way the exporter names them.
const N = cfg.stator.pcbLayers, spare = cfg.stator.pcbSpareLayers;
const cuName = (j) => (j === 0 ? 'F.Cu' : j === N - 1 ? 'B.Cu' : `In${j}.Cu`);
// B.Cu FIRST. Specctra layer index 0 is the component side, and every pad on
// this board is on B.Cu; declaring the inner spare layers ahead of it left the
// router with all its pads on its "back" side, and it routed WORSE with three
// layers than with two. The names are carried through to the .ses verbatim, so
// the order here is free to be whatever the router wants.
const layers = [];
for (let j = N - 1; j >= N - spare; j--) layers.push(cuName(j));

const board = readBoard(boardPath);

// Coil centres, from the same stator the board was built from, mapped into the
// board file's frame (the exporter centres the outline and keeps coords
// positive; recover that offset from the outline's own extent).
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const [x0, y0, x1, y1] of board.outline) {
  minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
  minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
}
const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
const coils = stator.coils.map((c) => [cx0 + c.x * 1000, cy0 - c.y * 1000]);

// A routing via may not be drilled anywhere the winding is. The keepout is the
// coil's copper outline and NOTHING MORE: freerouting adds the clearance and
// the via's own radius itself, so pre-growing it here charged both twice and
// shrank the legal gutter from 0.91 mm to 0.23 mm -- which is why the first
// runs placed four vias on a nine-coil board and extra layers bought nothing.
const routeVia = { name: 'Via_route', dia: vSize, drill: viaDrill(vSize) };
const coilKeepR = g.halfOut + g.trace / 2;
// The centre hole is copper-free on every winding layer, so it is via-legal --
// but only the part of it the coil's own inner crossovers leave free. Their
// lands sit on a ring; what is inside that ring, less a clearance, is the
// interior via site this board has.
const innerR = g.halfIn - g.trace / 2;
const rHole = innerR - FAB.minClearance - vSize / 2;      // crossover-via ring
const coilHoleR = Math.max(0, rHole - vSize / 2 - FAB.minClearance);
console.log(`coil centre hole: ${innerR.toFixed(3)} mm apothem, via-legal radius ${coilHoleR.toFixed(3)} mm (a via needs ${(vSize / 2).toFixed(3)})`);

// The terminal vias are represented by the coil's I/O pads (which cover them),
// so only the crossovers are keepouts. Match by position against the Term pads.
const termAt = new Set();
for (const fp of board.fps) {
  if (fp.lib !== 'Term') continue;
  termAt.add(`${fp.x.toFixed(3)},${fp.y.toFixed(3)}`);
}
const isTerm = (v) => termAt.has(`${v.x.toFixed(3)},${v.y.toFixed(3)}`);
const keepVias = board.vias.filter((v) => !isTerm(v));
const termVias = board.vias.filter(isTerm);

// Every crossover/terminal stub, stamped onto every cell. viaPlan is the same
// call the exporter made, so these are the exact tabs that are on the board.
const plan = viaPlan(g, g.layers, cellHalf, vSize);
const stubW = g.trace;
// One keepout per DISTINCT tab, and only for tabs that reach outside the coil
// hexagon. Each crossover tab is drawn twice -- once on each of the two layers
// it joins -- at identical geometry, and the inner tabs live entirely inside
// the coil's own via_keepout hexagon. Emitting all of them made ~3400 redundant
// areas on the full board, and freerouting pays for every one on every pass.
const inHex = (x, y) => {
  let m = -Infinity;
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    m = Math.max(m, x * Math.cos(a) + y * Math.sin(a));
  }
  return m <= coilKeepR;
};
const stubs = [];
{
  const seen = new Set(), local = [];
  for (const [x0, y0, x1, y1] of [...plan.segments, ...plan.terminals]) {
    const k = `${x0.toFixed(4)},${y0.toFixed(4)},${x1.toFixed(4)},${y1.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (inHex(x0, y0) && inHex(x1, y1)) continue;   // the hexagon already covers it
    local.push([x0, y0, x1, y1]);
  }
  for (const [cxm, cym] of coils) {
    for (const [x0, y0, x1, y1] of local) stubs.push([cxm + x0, cym - y0, cxm + x1, cym - y1, stubW]);
  }
}

// --- the coil is a COMPONENT, not a net ------------------------------------
//
// On the board the winding is one continuous piece of copper, so its two
// terminals are one net and KiCad is right to say so. A router told the same
// thing does the obvious wrong thing: it sees four pads on `coil_0` -- both
// bridge outputs and both coil leads -- and satisfies the net by running a
// wire from OUTA straight to OUTB. That shorts the bridge, bypasses the coil,
// and reads as "routed".
//
// So the router is given the coil as a two-terminal component: OUTA and lead
// IN on `coil_i_A`, OUTB and lead OUT on `coil_i_B`, and the winding itself
// (which is what actually joins them) is not in its netlist at all. The pairing
// is the fixed convention emitBridge8 documents, not proximity, so the current
// direction means the same thing on every cell.
const netOverride = new Map();                   // "REF|pad" -> net name
{
  let coils2 = 0;
  for (const fp of board.fps) {
    const m = /^J(\d+)\.(IN|OUT)$/.exec(fp.ref);
    if (!m) continue;
    netOverride.set(`${fp.ref}|1`, `coil_${m[1]}_${m[2] === 'IN' ? 'A' : 'B'}`);
  }
  for (const fp of board.fps) {
    const m = /^U(\d+)$/.exec(fp.ref);
    if (!m || fp.lib === 'Term') continue;
    const outs = BRIDGE_OUT_PADS[fp.lib];
    if (!outs) continue;
    if (!fp.pads.some((pd) => pd.netName === `coil_${m[1]}`)) continue;
    netOverride.set(`${fp.ref}|${outs.a}`, `coil_${m[1]}_A`);   // OUTA -> J.IN
    netOverride.set(`${fp.ref}|${outs.b}`, `coil_${m[1]}_B`);   // OUTB -> J.OUT
    coils2++;
  }
  console.log(`split ${coils2} coils into A/B terminals`);
}

// --- lay the local nets before the router sees the board -------------------
//
// Nets with exactly TWO pads are point-to-point and their geometry is fixed by
// the placement: the bridge's outputs to its own coil's terminals, its inputs
// to the register that drives that cell, each shift-chain link to the next
// register. That is most of the netlist, it is identical in all 168 cells, and
// a maze router rediscovering it 500 times is what the plateau is made of.
// Multi-pad power gets the same treatment for SHORT hops only (a decap to the
// bridge beside it); joining the clusters up is left to freerouting.
const padsOf = new Map();                        // net -> [{ref, pad, x, y}]
for (const fp of board.fps) {
  for (const pd of fp.pads) {
    if (!layers.includes(pd.layer)) continue;
    const net = netOverride.get(`${fp.ref}|${pd.name}`) || pd.netName;
    if (!net) continue;
    if (!padsOf.has(net)) padsOf.set(net, []);
    padsOf.get(net).push({ ref: fp.ref, pad: pd.name, x: fp.x + pd.dx, y: fp.y + pd.dy, layer: pd.layer });
  }
}
const coilOf = (net) => {
  const m = /^coil_(\d+)_[AB]$/.exec(net);
  return m ? +m[1] + 1 : null;                   // board net number for that coil
};
const conns = [];
const HOP = +(process.env.PREWIRE_HOP || 4.0);   // mm: "beside it", for power
for (const [net, ps] of padsOf) {
  if (ps.length === 2) {
    conns.push({ net, coilNet: coilOf(net), a: [ps[0].x, ps[0].y], b: [ps[1].x, ps[1].y], layer: ps[0].layer });
  } else if (ps.length > 2) {
    // Nearest-neighbour hops, shortest first, skipping any pair already tied
    // together by the ones taken so far (a partial spanning forest).
    const pairs = [];
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
        if (d <= HOP) pairs.push({ i, j, d });
      }
    }
    pairs.sort((u, v) => u.d - v.d);
    const parent = ps.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const { i, j } of pairs) {
      const ri = find(i), rj = find(j);
      if (ri === rj) continue;
      parent[ri] = rj;
      conns.push({ net, coilNet: null, a: [ps[i].x, ps[i].y], b: [ps[j].x, ps[j].y], layer: ps[i].layer });
    }
  }
}
const field = makeField(board, (ref, pad, netName) => netOverride.get(`${ref}|${pad}`) || netName);
// OFF by default. Laying these as FIXED wiring cost freerouting far more than
// it saved: the same tile that routed in 2 minutes took over 10 with 31 of 75
// local connections pinned, and got no further. The code stays because the idea
// is right for a periodic board -- 168 identical cells should not be rediscovered
// 500 times -- but it wants a router that treats fixed copper as cheap, and this
// one does not. PREWIRE=1 to try it.
const pre = process.env.PREWIRE
  ? prewire(conns, field, { clearance: FAB.minClearance, width: Math.max(FAB.minTrace, 0.1) })
  : { laid: [], done: 0, tried: conns.length };
console.log(`pre-routed ${pre.done} of ${pre.tried} local connections`);

// CARRY=<board.kicad_pcb>: take the electronics-layer tracks off an
// already-routed board and hand them back to the router as a starting point.
let carried = [];
if (process.env.CARRY) {
  const prev = readBoard(process.env.CARRY);
  const nameOf = (n) => prev.nets.get(n);
  carried = prev.tracks
    .filter((t) => layers.includes(t.layer) && nameOf(t.net))
    .map((t) => ({ ...t, net: nameOf(t.net) }));

  // A carried coil track has the BOARD's net name -- `coil_i` -- but the router
  // is given the coil as two terminals, coil_i_A and coil_i_B, so a bare
  // `coil_i` would reference a net that does not exist and get dropped. That
  // silently threw away every coil trace on each round, which is a fifth of the
  // routing and exactly the part the router finds hardest.
  //
  // The copper knows which half it is: follow each track to whichever pad its
  // cluster reaches. Union-find over shared endpoints, then label each cluster
  // by the A-side or B-side pad it touches.
  {
    const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    const anchor = new Map();                    // endpoint -> half-net name
    for (const [k, net] of netOverride) {
      const [ref, pad] = k.split('|');
      const fp = board.fps.find((f) => f.ref === ref);
      const pd = fp && fp.pads.find((q) => q.name === pad);
      if (pd) anchor.set(key([fp.x + pd.dx, fp.y + pd.dy]), net);
    }
    const coilTracks = carried.filter((t) => /^coil_\d+$/.test(t.net));
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const add = (x) => { if (!parent.has(x)) parent.set(x, x); return find(x); };
    for (const t of coilTracks) { const a = add(key(t.a)), b = add(key(t.b)); if (a !== b) parent.set(a, b); }
    const label = new Map();                     // root -> half-net
    for (const [k, net] of anchor) if (parent.has(k)) label.set(find(k), net);
    let named = 0, lost = 0;
    for (const t of coilTracks) {
      const n = label.get(find(key(t.a))) || label.get(find(key(t.b)));
      if (n) { t.net = n; named++; } else lost++;
    }
    console.log(`carried ${carried.length} segments (${named} coil traces resolved to a terminal, ${lost} unanchored)`);
  }
}

const out = process.env.DSN_OUT || `${key}.route.dsn`;
const stats = writeDsn(board, {
  name: `${key}_route`,
  layers,
  // The fab's own clearance, exactly. (An earlier run needed 1.35x of it to
  // stop the router cutting inside the rule -- that turned out to be the
  // mirrored-pad bug in mkdsn, not the router: it was measuring against pad
  // shapes that were not the pads.)
  rule: {
    width: Math.max(FAB.minTrace, 0.1),
    clearance: FAB.minClearance,
    edge: process.env.NO_EDGE ? FAB.minClearance : FAB.edgeClearance,
  },
  via: routeVia,
  coils, coilKeepR, coilHoleR, keepVias, stubs, termVias, padLayer: 'B.Cu',
  // BLIND=1: the two electronics layers get their own via span (B.Cu <-> the
  // layer above it) that never enters the winding. That removes the constraint
  // this board's "plated through-holes only" rule puts on ROUTING vias -- with
  // through-holes, a via may only be drilled in the honeycomb's gutter, so
  // inside a cell B.Cu is the only layer a trace can actually get to and extra
  // electronics layers are unreachable. Measured on the 3x3 tile: 38 unrouted
  // with through-holes, 5 with blind vias (19 vias placed vs 116).
  blind: !!process.env.BLIND,
  noKeepout: !!process.env.NO_KEEPOUT || !!process.env.BLIND,
  noXVia: !!process.env.NO_XVIA,
  skipLibs: (process.env.SKIP_FP || '').split(',').filter(Boolean),
  netOverride,
  prewired: pre.laid,
  carried,
  onlyNets: (process.env.ONLY || '').split(',').filter(Boolean),
  planeNets: (process.env.PLANES || '').split(',').filter(Boolean),
  out,
});
console.log(JSON.stringify({
  preset: key, layers, via: routeVia, coilKeepR: +coilKeepR.toFixed(3),
  crossoverKeepouts: keepVias.length, ...stats,
  boardThicknessMm: +(pcbBoardThickness(N, cfg.stator.pcbCopperThickness) * 1000).toFixed(2),
}, null, 1));
console.log(`wrote ${out}`);
