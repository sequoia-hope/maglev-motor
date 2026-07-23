// The KiCad export is only worth shipping if the copper it writes is the coil
// the physics ran. These checks pin the two together: same layer count, same
// turns-per-layer, one net per coil, every track inside its coil, and -- the one
// that actually matters -- every layer winding the same way so the fields add
// instead of cancelling.

import { makeStator } from '../src/coils.js';
import { buildKiCad, pcbCoilGeometry, spiralPoints, spiralVertices, validatePcb, viaPlan } from '../src/kicad.js';

let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fails++; };

const cfg = {
  stator: {
    coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.096,
    windingHeight: 0.0016, wireDiameter: 0.0005, pcbTraceWidth: 0.000103,
    pcbCopperThickness: 35e-6, pcbLayers: 12, lockCoilPitch: false,
  },
};
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 4 });
const g = pcbCoilGeometry(cfg);
const out = buildKiCad(stator, cfg);

console.log('=== geometry matches coils.js ===');
// coils.js: perLayer = floor((w*0.25)/(traceWidth*2)); effTurns = perLayer*layers.
check('turns-per-layer matches the filament model',
  g.turns === stator.effTurns / cfg.stator.pcbLayers, `${g.turns} vs ${stator.effTurns / cfg.stator.pcbLayers}`);
check('inner radius stays positive (winding fits the window)', g.halfIn > 0, `${g.halfIn.toFixed(3)} mm`);
check('adjacent turns clear by one trace width',
  Math.abs((g.pitch - g.trace) - g.trace) < 1e-9, `gap ${(g.pitch - g.trace).toFixed(4)} mm vs trace ${g.trace} mm`);

console.log('\n=== every layer winds the same way, so fields add ===');
// Shoelace signed area: CCW is positive. If any layer came out negative it would
// be wound backwards and its field would subtract from the stack.
const signedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return a / 2;
};
const areas = Array.from({ length: cfg.stator.pcbLayers }, (_, j) => signedArea(spiralPoints(g, j)));
check('all layers circulate the same direction (CCW)',
  areas.every((a) => a > 0), `signs: ${areas.map((a) => (a > 0 ? '+' : '-')).join('')}`);
check('the inward and outward layers enclose about the same area',
  Math.max(...areas) / Math.min(...areas) < 1.05,
  `min ${Math.min(...areas).toFixed(1)} max ${Math.max(...areas).toFixed(1)} mm^2`);
// A layer's run is turns full loops (4 corner vertices each) plus the small
// fraction-of-a-turn that fans the ends apart, plus the two endpoints.
check('each layer draws the turn count from the model (plus the distribution sliver)',
  spiralVertices(g, 0).length >= g.turns * 4 + 1 && spiralVertices(g, 0).length <= g.turns * 4 + 4,
  `${spiralVertices(g, 0).length} vertices for ${g.turns} turns`);
// Rounding the corners adds points between the vertices without moving the ends.
check('the corners are rounded (more drawn points than raw vertices)',
  spiralPoints(g, 0).length > spiralVertices(g, 0).length
  && spiralPoints(g, 0)[0].join() === spiralVertices(g, 0)[0].join(),
  `${spiralPoints(g, 0).length} drawn vs ${spiralVertices(g, 0).length} vertices`);

console.log('\n=== the board is what the stator is ===');
check('one copper layer per declared PCB layer',
  (out.text.match(/signal\)/g) || []).length === cfg.stator.pcbLayers,
  `${(out.text.match(/signal\)/g) || []).length} layers`);
check('F.Cu and B.Cu both present', /"F.Cu"/.test(out.text) && /"B.Cu"/.test(out.text));
check('one net per coil (plus the empty net 0)',
  out.stats.nets === stator.coils.length && (out.text.match(/^  \(net \d+ "coil_/gm) || []).length === stator.coils.length,
  `${out.stats.nets} nets`);

console.log('\n=== the coil board is passive; drivers live on a backplane ===');
// The dense coil board carries no components -- the amplifier array moved to a
// mating backplane, freeing every layer (and the centre) for copper.
check('coil board is passive (no footprints)',
  !/\(footprint /.test(out.text) && out.stats.drivers === 0);
check('every net is a coil net (no power rails on the coil board)',
  !/^  \(net \d+ "(VBUS|GND|PWMA_)/m.test(out.text));

console.log('\n=== outer crossovers sit in the rounded-corner pockets ===');
// Every crossover via must land outside the innermost turn (not buried in the
// winding) and inside the coil cell. Inner hops sit in the centre hole; outer
// hops sit near the four corners. Check they distribute across more than one
// corner (not all stacked on one side like the old gutter line).
{
  const S = cfg.stator.statorSize * 1000;
  const cen = [S / 2 + 10 + stator.coils[0].x * 1000, S / 2 + 10 - stator.coils[0].y * 1000];
  const viaRe = /\(via \(at ([\d.]+) ([\d.]+)\)[^\n]*net (\d+)\)/g;
  const corners = new Set();
  let mm, outer = 0;
  while ((mm = viaRe.exec(out.text))) {
    if (+mm[3] !== 1) continue;
    const x = +mm[1] - cen[0], y = +mm[2] - cen[1], r = Math.hypot(x, y);
    if (r > g.halfIn + g.pitch) { // an outer/corner via, not a centre-hole one
      outer++;
      corners.add((Math.round(Math.atan2(y, x) / (Math.PI / 2)) + 4) % 4);
    }
  }
  check('outer crossovers are spread across multiple corners', corners.size >= 3,
    `${outer} outer vias across ${corners.size} corners`);
}

console.log('\n=== no plated through-hole contacts a layer it must not ===');
// The one that actually shorts a coil: a crossover through-hole grazing another
// layer's copper. validatePcb checks every via against every non-participating
// layer. This design (and the shipped fill) must come back clean.
{
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const bad = validatePcb(g, cfg.stator.pcbLayers, cfg.stator.coilPitch * 1000 / 2, via);
  check('every through-hole clears the layers it does not stitch', bad.length === 0,
    `${bad.length} wrong-layer contacts`);
  // And it must actually FIRE when a via cannot clear -- a validator that never
  // fails is worthless. (The distributed-ends routing is clean at any fill, so
  // density no longer breaks it; an oversized via does.)
  check('the check catches vias that cannot clear (oversized)',
    validatePcb(g, cfg.stator.pcbLayers, cfg.stator.coilPitch * 1000 / 2, g.pitch * 3).length > 0);
}

console.log('\n=== the crossovers wire every layer into one series chain ===');
// The whole point of the stitching: L0..L(N-1) in series, so the fields add and
// the two terminals are the coil's leads. Each crossover must join exactly two
// ADJACENT layers (and both those layers share that one via -- not a via each).
{
  const N = cfg.stator.pcbLayers;
  const via = Math.min(0.4, Math.max(0.2, g.pitch * 0.6));
  const plan = viaPlan(g, N, cfg.stator.coilPitch * 1000 / 2, via);
  check('each crossover via joins exactly two adjacent layers',
    plan.vias.every((v) => v.layers.length === 2 && Math.abs(v.layers[0] - v.layers[1]) === 1),
    `${plan.vias.length} crossovers`);
  const adj = Array.from({ length: N }, () => []);
  for (const v of plan.vias) { adj[v.layers[0]].push(v.layers[1]); adj[v.layers[1]].push(v.layers[0]); }
  const ends = adj.map((a, i) => (a.length === 1 ? i : -1)).filter((i) => i >= 0);
  let cur = ends[0], prev = -1, len = 0; const seen = new Set();
  while (cur !== undefined && !seen.has(cur)) { seen.add(cur); len++; const nx = adj[cur].find((x) => x !== prev && !seen.has(x)); prev = cur; cur = nx; }
  check('they form ONE series chain L0..L(N-1) with two free ends', ends.length === 2 && len === N,
    `chain covers ${len}/${N}, ${ends.length} free ends`);
  check('the two free ends carry the coil terminals', plan.termVias.length === 2,
    `${plan.termVias.length} terminal vias`);
}
check('through-hole via farms stitch the layer stack, per coil',
  out.stats.vias === stator.coils.length * out.stats.viasPerCoil && out.stats.viasPerCoil > 0,
  `${out.stats.vias} vias, ${out.stats.viasPerCoil}/coil (${out.stats.innerVias} inner + ${out.stats.outerVias} outer)`);
// Bugeja's method is plated through-holes only: every via must span the full
// stack (F.Cu..B.Cu). A blind/buried span would betray the cheap-stackup claim.
{
  const viaLines = out.text.match(/\(via .*/g) || [];
  const allThrough = viaLines.length > 0 && viaLines.every((v) => /\(layers "F.Cu" "B.Cu"\)/.test(v));
  check('every via is a plated through-hole (F.Cu..B.Cu), none buried', allThrough,
    `${viaLines.length} vias, ${viaLines.filter((v) => !/"F.Cu" "B.Cu"/.test(v)).length} not through-hole`);
}
check('board outline is the stator size',
  new RegExp(`Edge.Cuts`).test(out.text) && out.stats.boardMm === cfg.stator.statorSize * 1000,
  `${out.stats.boardMm} mm`);

console.log('\n=== the file is well-formed ===');
const opens = (out.text.match(/\(/g) || []).length, closes = (out.text.match(/\)/g) || []).length;
check('parentheses balance', opens === closes, `${opens} open, ${closes} close`);
check('starts with a kicad_pcb node', /^\(kicad_pcb /.test(out.text));

// Every track must sit inside its own coil CELL (half the coil pitch), or it
// would collide with the neighbour. The crossover tabs and vias now spread out
// into the gutter to reach the corner pockets, so the bound is the cell, not the
// winding edge -- validatePcb already guards the electrical side.
console.log('\n=== tracks stay inside their coils ===');
const half = cfg.stator.coilPitch * 1000 / 2 + 1e-6;
let overflow = 0;
const segRe = /\(segment \(start ([\d.]+) ([\d.]+)\) \(end ([\d.]+) ([\d.]+)\).*?net (\d+)\)/g;
const centres = stator.coils.map((c) => [c.x * 1000 + (cfg.stator.statorSize * 1000 / 2 + 10), -c.y * 1000 + (cfg.stator.statorSize * 1000 / 2 + 10)]);
let mm;
while ((mm = segRe.exec(out.text))) {
  const net = +mm[5]; if (!net) continue;
  const [cx, cy] = centres[net - 1];
  for (const [x, y] of [[+mm[1], +mm[2]], [+mm[3], +mm[4]]]) {
    if (Math.abs(x - cx) > half || Math.abs(y - cy) > half) overflow++;
  }
}
check('no track escapes its coil footprint', overflow === 0, `${overflow} stray endpoints`);

console.log('\n=== non-PCB coils export nothing ===');
check('a wound stator yields no board',
  buildKiCad(makeStator({ ...cfg.stator, coilType: 'square', ringsPerCoil: 2, segmentsPerSide: 4 }),
    { stator: { ...cfg.stator, coilType: 'square' } }) === null);

console.log(fails ? `\n${fails} FAILURES` : '\nall kicad checks pass');
process.exit(fails ? 1 : 0);
