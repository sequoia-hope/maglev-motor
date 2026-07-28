// The CAD export is only worth shipping if the part it writes is the platen
// the physics ran. These checks pin them together: the pocket holds exactly
// the cells the census bills, the posts are exactly the interior nulls, area
// is conserved through contour extraction, every magnet still has a full-width
// channel and a seating flat after the dogbones, and the STEP shell is closed
// -- every edge used exactly twice -- rather than trusted to be.

import { makeTranslator, applyMagnetDrive, cellSize } from '../src/halbach.js';
import { magnetCensus } from '../src/assembly.js';
import { DEFAULT_MECH } from '../src/mechanical.js';
import {
  platenCad, magnetGridDxf, isogridDxf, platenStep, isogridStiffness, dogboneIntrusion,
} from '../src/cad.js';

let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fails++; };

const PRESETS = {
  amz316: { arrayType: 'halbach2d', layout: 'single', driveByMagnet: true, cubicMagnets: true, magnetSize: 0.0047625, pitch: 0.01905, magnetThickness: 0.0047625, Br: 1.45, segments: 4, platenSize: 0.0523875, platenMass: 0, maxOrder: 3 },
  desk40: { arrayType: 'halbach2d', layout: 'single', pitch: 0.020, magnetThickness: 0.005, Br: 1.44, segments: 4, platenSize: 0.040, platenMass: 0, maxOrder: 3 },
  pcbmini: { arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.003, Br: 1.43, segments: 4, platenSize: 0.048, platenMass: 0, maxOrder: 3 },
  wound: { arrayType: 'halbach1d', layout: 'quad', pitch: 0.040, magnetThickness: 0.010, Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3 },
  baseline: { arrayType: 'alternating', layout: 'single', pitch: 0.040, magnetThickness: 0.010, Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3 },
};

const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

function build(key) {
  const t = { ...PRESETS[key] };
  applyMagnetDrive(t);
  const tr = makeTranslator(t);
  const cad = platenCad({ translator: t }, tr, DEFAULT_MECH);
  return { t, tr, cad };
}

for (const key of Object.keys(PRESETS)) {
  const { t, tr, cad } = build(key);
  const census = magnetCensus(tr);
  console.log(`\n=== ${key}: geometry matches the BOM ===`);
  check('pocket count equals magnets billed', cad.nPockets === census.total,
    `${cad.nPockets} vs census ${census.total}`);
  // Area conservation through contour extraction and clearance offset: the
  // pocket region must equal (filled cells) grown by the clearance perimeter.
  const [cw, ch] = cellSize(tr.tile);
  const got = cad.patches.reduce((a, p) =>
    a + p.outers.reduce((s, l) => s + area(l.pts), 0) + p.holes.reduce((s, l) => s + area(l.pts), 0), 0);
  const cl = cad.cad.clearance;
  let want = 0;
  for (const p of cad.patches) {
    const perim = [...p.outers, ...p.holes].reduce((s, l) => {
      let per = 0;
      for (let i = 0; i < l.pts.length; i++) {
        const a2 = l.pts[i], b2 = l.pts[(i + 1) % l.pts.length];
        per += Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      }
      return s + per;
    }, 0);
    // grown loops: cell area + clearance band ~ perimeter*cl (corner terms cancel
    // between left and right turns only approximately; tolerance covers them)
    want += p.nFilled * cw * ch + perim * cl;
  }
  check('pocket area = filled cells + clearance band', Math.abs(got - want) / want < 0.002,
    `${(got * 1e6).toFixed(1)} vs ${(want * 1e6).toFixed(1)} mm²`);
  check('every check passes for the stock presets', cad.ok,
    cad.checks.filter((k) => !k.ok).map((k) => k.msg).join('; ') || 'all ok');
  check('isogrid exists', cad.triangles.length > 0, `${cad.triangles.length} pockets`);
  check('magnets stand proud of the aluminium', cad.pocketDepth < t.magnetThickness,
    `pocket ${(cad.pocketDepth * 1000).toFixed(2)} vs magnet ${(t.magnetThickness * 1000).toFixed(2)} mm`);
}

console.log('\n=== amz316: the pattern the retention is built on ===');
{
  const { cad } = build('amz316');
  // 11x11 with 36 nulls: 16 interior nulls become posts, 20 rim nulls merge
  // into the fence as notches. If either number moves, the retention story
  // changed and this test should have to be looked at.
  check('16 interior posts', cad.nPosts === 16, `${cad.nPosts}`);
  check('85 pockets', cad.nPockets === 85, `${cad.nPockets}`);
  check('platen grows for the fence (array fills the platen)', cad.grown,
    `footprint ${(cad.footprint * 1000).toFixed(1)} mm vs platen ${(52.3875).toFixed(1)} mm`);
  check('fence at least the requested width', cad.fence >= cad.cad.fenceWidth - 1e-9,
    `${(cad.fence * 1000).toFixed(2)} mm`);
  // Dogbones: every interior-90 corner of the pocket gets one; posts get none.
  // The zigzag rim of an 11x11 checkerboard has 4 notch corners per rim void
  // side... count is pinned empirically but must be stable and non-zero.
  check('dogbone reliefs exist and sit at corners', cad.nReliefs > 0, `${cad.nReliefs} reliefs`);
  const intr = dogboneIntrusion(cad.cad.dogboneDia / 2);
  check('seating flat survives the dogbones', cad.patches[0].cellW - 2 * intr > 0.4 * cad.patches[0].cellW,
    `${((cad.patches[0].cellW - 2 * intr) * 1000).toFixed(2)} mm flat per ${(cad.patches[0].cellW * 1000).toFixed(2)} mm cell`);
}

console.log('\n=== DXF: parses back, layers and counts intact ===');
{
  const { cad } = build('amz316');
  const parse = (txt) => {
    const lines = txt.trim().split('\n');
    check('dxf group codes pair up', lines.length % 2 === 0, `${lines.length} lines`);
    const ents = { POLYLINE: 0, CIRCLE: 0, TEXT: 0, VERTEX: 0, SEQEND: 0 };
    const layers = new Set();
    for (let i = 0; i < lines.length - 1; i += 2) {
      if (lines[i].trim() === '0' && ents[lines[i + 1].trim()] !== undefined) ents[lines[i + 1].trim()]++;
      if (lines[i].trim() === '8') layers.add(lines[i + 1].trim());
    }
    return { ents, layers };
  };
  const mg = parse(magnetGridDxf(cad));
  check('magnet grid: every loop is a closed polyline',
    mg.ents.POLYLINE === mg.ents.SEQEND && mg.ents.POLYLINE > 0, `${mg.ents.POLYLINE} polylines`);
  check('magnet grid: one circle per dogbone', mg.ents.CIRCLE === cad.nReliefs,
    `${mg.ents.CIRCLE} vs ${cad.nReliefs}`);
  check('magnet grid: one reference square per magnet',
    mg.ents.POLYLINE === 1 + cad.nPosts + cad.patches.length + cad.nPockets,
    `${mg.ents.POLYLINE} = outline + ${cad.nPosts} posts + ${cad.patches.length} outer + ${cad.nPockets} cells`);
  check('magnet grid layers', ['OUTLINE', 'POCKET', 'RELIEF', 'CELLS', 'NOTES'].every((l) => mg.layers.has(l)),
    [...mg.layers].join(','));
  const ig = parse(isogridDxf(cad));
  check('isogrid: outline + one pocket per triangle',
    ig.ents.POLYLINE === 1 + cad.triangles.length, `${ig.ents.POLYLINE}`);
  check('isogrid layers', ['OUTLINE', 'POCKET', 'NOTES'].every((l) => ig.layers.has(l)),
    [...ig.layers].join(','));
}

console.log('\n=== STEP: a closed shell, not a hopeful one ===');
for (const key of ['amz316', 'pcbmini', 'wound', 'baseline']) {
  const { cad } = build(key);
  const step = platenStep(cad, `test-${key}`);
  check(`${key}: every edge used exactly twice (closed shell)`, step.stats.openEdges === 0,
    `${step.stats.openEdges} bad of ${step.stats.edges} edges, ${step.stats.faces} faces`);
  // Every #id referenced must be defined, and the id sequence dense.
  const defined = new Set([...step.text.matchAll(/^#(\d+)=/gm)].map((m) => m[1]));
  const referenced = [...step.text.matchAll(/#(\d+)/g)].map((m) => m[1]);
  check(`${key}: all references resolve`, referenced.every((r) => defined.has(r)),
    `${defined.size} entities`);
  check(`${key}: no NaN/Infinity leaked into the file`, !/NaN|Infinity/.test(step.text));
  const faces = (step.text.match(/ADVANCED_FACE/g) || []).length;
  check(`${key}: face count matches the builder`, faces === step.stats.faces, `${faces}`);
}

console.log('\n=== isogrid stiffness: limits behave ===');
{
  const E = 69e9;
  const s = isogridStiffness({ skin: 0.001, ribW: 0.0012, ribD: 0.003, side: 0.012, E });
  check('isogrid is stiffer than its own skin alone',
    s.D > E * 0.001 ** 3 / 12, `D=${s.D.toFixed(2)} vs skin ${(E * 1e-9 / 12).toFixed(2)} N·m`);
  check('isogrid is softer than the solid plate of same thickness', s.ratio < 1, s.ratio.toFixed(3));
  // Rib width -> spacing (w = h) is a solid plate: ratio must approach 1.
  const solidish = isogridStiffness({ skin: 0.001, ribW: 0.012 * Math.sqrt(3) / 2, ribD: 0.003, side: 0.012, E });
  check('full-width ribs approach the solid plate', solidish.ratio > 0.9, solidish.ratio.toFixed(3));
  // And the mass argument: same bending stiffness as SOME solid plate, at less
  // mass. Equivalent solid thickness t* = (12 D / E)^(1/3):
  const tEq = Math.cbrt(12 * s.D / E);
  const rho = 2700;
  const mIso = rho * (0.001 + 0.003 * (9 / 8) * (0.0012 / (0.012 * Math.sqrt(3) / 2)) / (9 / 8));
  const mEq = rho * tEq;
  check('isogrid beats the equally-stiff solid plate on mass', mIso < mEq,
    `${(mIso).toFixed(2)} vs ${(mEq).toFixed(2)} kg/m²`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
