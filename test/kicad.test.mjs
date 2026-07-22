// The KiCad export is only worth shipping if the copper it writes is the coil
// the physics ran. These checks pin the two together: same layer count, same
// turns-per-layer, one net per coil, every track inside its coil, and -- the one
// that actually matters -- every layer winding the same way so the fields add
// instead of cancelling.

import { makeStator } from '../src/coils.js';
import { buildKiCad, pcbCoilGeometry, spiralPoints } from '../src/kicad.js';

let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fails++; };

const cfg = {
  stator: {
    coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.096,
    windingHeight: 0.0016, wireDiameter: 0.0005, pcbTraceWidth: 0.0001,
    pcbCopperThickness: 175e-6, pcbLayers: 12, lockCoilPitch: false,
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
// A layer's run is turns full loops: 4 points per turn plus the closing point.
check('each layer draws exactly the turn count from the model',
  spiralPoints(g, 0).length === g.turns * 4 + 1, `${spiralPoints(g, 0).length} points`);

console.log('\n=== the board is what the stator is ===');
check('one copper layer per declared PCB layer',
  (out.text.match(/signal\)/g) || []).length === cfg.stator.pcbLayers,
  `${(out.text.match(/signal\)/g) || []).length} layers`);
check('F.Cu and B.Cu both present', /"F.Cu"/.test(out.text) && /"B.Cu"/.test(out.text));
check('one net per coil (plus the empty net 0)',
  out.stats.nets === stator.coils.length && (out.text.match(/\(net \d+ "coil_/g) || []).length === stator.coils.length,
  `${out.stats.nets} nets`);
check('a via between every adjacent layer pair, per coil',
  out.stats.vias === stator.coils.length * (cfg.stator.pcbLayers - 1), `${out.stats.vias} vias`);
check('board outline is the stator size',
  new RegExp(`Edge.Cuts`).test(out.text) && out.stats.boardMm === cfg.stator.statorSize * 1000,
  `${out.stats.boardMm} mm`);

console.log('\n=== the file is well-formed ===');
const opens = (out.text.match(/\(/g) || []).length, closes = (out.text.match(/\)/g) || []).length;
check('parentheses balance', opens === closes, `${opens} open, ${closes} close`);
check('starts with a kicad_pcb node', /^\(kicad_pcb /.test(out.text));

// Every track must sit inside its own coil's outer square, or coils would short
// across the board. Check the extreme coil corners against each coil centre.
console.log('\n=== tracks stay inside their coils ===');
const half = g.halfOut + g.pitch + 1e-6; // + terminal stub + fp slack
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
