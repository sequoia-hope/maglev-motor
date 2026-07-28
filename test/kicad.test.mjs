// The KiCad export is only worth shipping if the copper it writes is the coil
// the physics ran. These checks pin the two together: same layer count, same
// turns-per-layer, one net per coil, every track inside its coil, and -- the one
// that actually matters -- every layer winding the same way so the fields add
// instead of cancelling.

import { makeStator } from '../src/coils.js';
import { buildKiCad, buildTile, pcbCoilGeometry, spiralPoints, spiralVertices, validatePcb, viaPlan } from '../src/kicad.js';

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

console.log('\n=== the coil board carries only its I/O pads; drivers are on a backplane ===');
// No amplifier components (those moved to the mating backplane) -- the only
// footprints are the two SMT input/output pads per coil.
check('no driver components on the coil board',
  !/"maglev:(HB6|C0402)"/.test(out.text) && out.stats.drivers === 0);
check('two SMT terminal pads per coil, on B.Cu',
  (out.text.match(/\(footprint "maglev:Term" \(layer "B.Cu"\)/g) || []).length === stator.coils.length * 2
  && out.stats.termPads === stator.coils.length * 2,
  `${out.stats.termPads} pads`);
check('the I/O pads clear the winding and neighbours (validatePcb)',
  validatePcb(g, cfg.stator.pcbLayers, cfg.stator.coilPitch * 1000 / 2,
    Math.min(0.4, Math.max(0.2, g.pitch * 0.6))).filter((c) => c.pad).length === 0);
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

// The honeycomb topology is the same PCB machinery with a hexagonal (6-sided)
// spiral: it must export just as clean copper as the square grid -- additive
// winding sense, one series chain, plated through-holes only, no wrong-layer
// contacts -- and its board must be large enough to hold the hex-packed coils.
console.log('\n=== hexagonal honeycomb coils export a clean board ===');
{
  // The honeycomb needs a little more inter-coil gutter than the square grid to
  // route its I/O pads (the shipped preset uses 0.84 fill for exactly this).
  const hcfg = { stator: { ...cfg.stator, coilType: 'pcbhex', coilFill: 0.84 } };
  const hstat = makeStator({ ...hcfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const hg = pcbCoilGeometry(hcfg);
  const N = hcfg.stator.pcbLayers;
  const cellHalf = hcfg.stator.coilPitch * 1000 / 2;
  const hvia = Math.min(0.4, Math.max(0.2, hg.pitch * 0.6));
  check('geometry is a hexagon (6 sides)', hg.sides === 6, `${hg.sides} sides`);
  const hAreas = Array.from({ length: N }, (_, j) => signedArea(spiralPoints(hg, j)));
  check('every hex layer winds the same way (fields add)', hAreas.every((a) => a > 0),
    hAreas.map((a) => (a > 0 ? '+' : '-')).join(''));
  check('the hex layers enclose about equal area (nested turns)',
    Math.max(...hAreas) / Math.min(...hAreas) < 1.05,
    `ratio ${(Math.max(...hAreas) / Math.min(...hAreas)).toFixed(3)}`);
  const hplan = viaPlan(hg, N, cellHalf, hvia);
  check('each hex crossover joins two adjacent layers',
    hplan.vias.every((v) => v.layers.length === 2 && Math.abs(v.layers[0] - v.layers[1]) === 1),
    `${hplan.vias.length} crossovers`);
  check('no hex through-hole contacts a wrong layer (validatePcb)',
    validatePcb(hg, N, cellHalf, hvia).length === 0);
  const hout = buildKiCad(hstat, hcfg);
  check('the hex coil board is non-null and well-formed',
    hout && (hout.text.match(/\(/g) || []).length === (hout.text.match(/\)/g) || []).length);
  check('hex board is more coils than the square grid (denser packing)',
    hout.stats.coils > (out.stats.coils), `${hout.stats.coils} hex vs ${out.stats.coils} square`);
  const hViaLines = hout.text.match(/\(via .*/g) || [];
  check('every hex via is a plated through-hole (F.Cu..B.Cu)',
    hViaLines.length > 0 && hViaLines.every((v) => /\(layers "F.Cu" "B.Cu"\)/.test(v)));
  // The board outline must contain every coil: no coil centre may sit outside the
  // half-edge the export reports.
  const hHalf = hout.stats.boardMm / 2;
  const inside = hstat.coils.every((c) => Math.abs(c.x * 1000) < hHalf && Math.abs(c.y * 1000) < hHalf);
  check('the hex board outline contains every coil', inside, `board ${hout.stats.boardMm.toFixed(1)} mm`);
  const htile = buildTile(hcfg, 3);
  check('a 3×3 hex tile builds', htile !== null && htile.stats.coils > 0,
    `${htile ? htile.stats.coils : 0} coils`);
}

// A spare (electronics) layer surrenders bottom copper to parts: the physical
// stackup keeps every layer, but the winding must stop one short -- and with
// zero spare layers the export must not change AT ALL, because that path ships.
console.log('\n=== spare electronics layers: wind less, press the same board ===');
{
  const base = { stator: { ...cfg.stator, coilType: 'pcbhex', coilFill: 0.84 } };
  const drv = { stator: { ...base.stator, pcbSpareLayers: 1 } };
  const N = base.stator.pcbLayers;
  const g0 = pcbCoilGeometry(base), g1 = pcbCoilGeometry(drv);
  check('spare=0 winds every layer', g0.layers === N && g0.physLayers === N,
    `${g0.layers} of ${g0.physLayers}`);
  check('spare=1 winds one fewer layer, same physical stack',
    g1.layers === N - 1 && g1.physLayers === N, `${g1.layers} of ${g1.physLayers}`);
  const s0 = makeStator({ ...base.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const s1 = makeStator({ ...drv.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  check('physics turns drop by exactly one layer of turns',
    s1.effTurns === s0.effTurns - g0.turns, `${s1.effTurns} vs ${s0.effTurns}`);
  check('board thickness is unchanged (the fab presses the same stack)',
    Math.abs(s1.thickness - s0.thickness) < 1e-12, `${(s1.thickness * 1e3).toFixed(3)} mm`);
  check('the surviving winding centroid sits closer to the magnets',
    s1.coils[0].z > s0.coils[0].z, `${(s1.coils[0].z * 1e3).toFixed(3)} vs ${(s0.coils[0].z * 1e3).toFixed(3)} mm`);
  const k1 = buildKiCad(s1, drv);
  check('spare=1 exports every physical layer in the stackup',
    (k1.text.match(/"(?:F|B|In\d+)\.Cu" signal/g) || []).length === N);
  // The bottom copper is the electronics face: via annulars and I/O pads may
  // touch it, spiral tracks must not. The deepest spiral lives on In(N-2).
  const laid = new Set((k1.text.match(/\(segment .*?\(layer "([^"]+)"\)/g) || [])
    .map((s) => s.match(/\(layer "([^"]+)"\)/)[1]));
  check('no spiral or stub copper lands on the electronics layer (B.Cu)',
    !laid.has('B.Cu'), [...laid].sort().join(','));
  check(`the deepest winding layer is In${N - 2}.Cu`, laid.has(`In${N - 2}.Cu`));
  check('vias stay full-stack plated through-holes',
    (k1.text.match(/\(via .*/g) || []).every((v) => /\(layers "F.Cu" "B.Cu"\)/.test(v)));
  check('I/O pads still land on the back (electronics) face',
    /\(pad "1" smd rect .*\(layers "B.Cu" "B.Paste" "B.Mask"\)/.test(k1.text));
  const cellHalf = base.stator.coilPitch * 1000 / 2;
  const hvia = Math.min(0.4, Math.max(0.2, g1.pitch * 0.6));
  check('spare=1 winding validates clean (validatePcb over the coil layers)',
    validatePcb(g1, g1.layers, cellHalf, hvia).length === 0);
}

// The electronics-layer fit check: the single-board driver-per-coil build only
// exists if solder pads can land clear of the through-via fields. These pin the
// shipped verdicts (SOP-8 bridges DO fit per hex cell -- pads on the bare-mask
// winding annulus) and make the search re-verify its own answers.
console.log('\n=== electronics-layer fit: the parts land clear of the via fields ===');
{
  const { backsideFit, backsideObstacles, placementClear, FOOTPRINTS } = await import('../src/kicad.js');
  const hcfg = { stator: { ...cfg.stator, coilType: 'pcbhex', coilFill: 0.84, pcbSpareLayers: 1 } };
  const hstat = makeStator({ ...hcfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const fit = backsideFit(hcfg, { stator: hstat, sensorSpacing: 0.0216 });
  check('fit check runs on the hex electronics layer', fit.available === true,
    `${fit.obstaclesPerCell} keepouts/cell`);
  check('a per-cell SOP-8 bridge fits (the single-board build is viable)',
    fit.parts.sop8.fits === true,
    fit.parts.sop8.fits ? `at (${fit.parts.sop8.at.map((v) => v.toFixed(2))}) rot ${fit.parts.sop8.rotDeg}°` : '');
  check('the DFN fallback fits too', fit.parts.dfn8.fits === true);
  // The register and sensor verdicts are now judged BESIDE the chosen bridge
  // (obs2), and at 0.84 fill the honest answer is that nothing else tiles
  // per-cell next to a SOP-8 -- the cell is full. That discovery is the whole
  // reason the overlapping-driver bug existed: the old card said "fits" while
  // grading an empty cell. What must still succeed is the sparse PLAN below.
  check('the full plan still places every register (package escalation)',
    fit.registers && fit.registers.every((r) => r.fits),
    fit.registers ? `${fit.registers.length} registers as ${fit.planStats.regPackage}` : 'no plan');
  check('a dense cell escalates the register package rather than overlapping',
    ['tssop16', 'qfn16'].includes(fit.planStats.regPackage));
  // The search must not be grading its own homework: re-verify every returned
  // placement independently through placementClear.
  const obs = backsideObstacles(hcfg);
  const allClear = Object.entries(fit.parts).every(([k, p]) =>
    !p.fits || placementClear(FOOTPRINTS[k], p.at[0], p.at[1], (p.rotDeg * Math.PI) / 180, obs, fit.clearance));
  check('every reported placement re-validates against the obstacle list', allClear);
  // The periodic-copy check has to actually bite. Note a part longer than the
  // pitch in ONE dimension can still legitimately tile the triangular lattice
  // by threading between columns (the first version of this test learned that);
  // only a part bigger than the pitch in BOTH dimensions is truly untileable.
  const tooBig = { label: 'too big', body: [9.0, 9.0], pads: [[-4.2, -4.2, 0.5, 0.5], [4.2, 4.2, 0.5, 0.5]] };
  const fw = backsideFit(hcfg, { footprints: { tooBig } });
  check('a part bigger than the pitch both ways is rejected by the tiling check',
    fw.parts.tooBig.fits === false);
  // The nudge budget is 2.5 mm (a RADIUS now, not a box corner), and the
  // sensors dodge REAL parts -- bridges included -- so nudges run larger than
  // when the search graded a bare cell. The observability cost of the placed
  // grid is what actually matters, and analysis.test re-checks it as-placed.
  check('sensor grid places completely within its nudge budget',
    fit.sensors && fit.sensors.failed === 0 && fit.sensors.worstNudgeMm <= 2.5 + 1e-9,
    fit.sensors ? `${fit.sensors.placed}/${fit.sensors.wanted}, worst nudge ${fit.sensors.worstNudgeMm.toFixed(2)} mm` : '');
  // plan: false is the UI's fast path -- the per-package card without the
  // tens-of-seconds placement plan (which runs in a worker instead). It must
  // return the card and clearly NOT pretend to have planned anything.
  const cardOnly = backsideFit(hcfg, { stator: hstat, sensorSpacing: 0.0216, plan: false });
  check('plan: false returns the card only (no registers, no sensors, no service)',
    cardOnly.available === true && !!cardOnly.parts.sop8
    && !cardOnly.registers && !cardOnly.sensors && !cardOnly.service);
  check('no electronics layer -> no single-board fit to report',
    backsideFit({ stator: { ...cfg.stator, coilType: 'pcbhex' } }).available === false);
  check('non-PCB stators are refused',
    backsideFit({ stator: { ...cfg.stator, coilType: 'square' } }).available === false);
  // The square PCB grid goes through the same machinery.
  const sq = backsideFit({ stator: { ...cfg.stator, pcbSpareLayers: 1 } });
  check('square-grid electronics layer fits a bridge as well', sq.available && sq.parts.sop8.fits);
}

// The shift chain and the firmware contract. A PWM net is only real if exactly
// one register output drives it; a contract is only real if it is a bijection
// between frame bits and coil pins. Both are parsed back out of the emitted
// text, so the board and the map cannot disagree.
console.log('\n=== shift chain: the PWM nets are driven, and the contract is a bijection ===');
{
  const { buildDriverBackplane, buildKiCad, chainPlan } = await import('../src/kicad.js');
  const scfg = { stator: { ...cfg.stator, coilType: 'pcbhex', coilFill: 0.84, statorSize: 0.024 } };
  const sstat = makeStator({ ...scfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const C = sstat.coils.length;

  const plan = chainPlan(sstat, scfg);
  const seen = new Set();
  plan.registers.forEach((r) => r.coils.forEach((c) => seen.add(c)));
  check('every coil appears in exactly one register quad',
    seen.size === C && plan.registers.reduce((a, r) => a + r.coils.length, 0) === C,
    `${C} coils across ${plan.registers.length} registers`);
  const bits = plan.bitMap.map((b) => b.bit);
  check('frame bits are a permutation of 0..bits-1',
    new Set(bits).size === plan.bits && Math.min(...bits) === 0 && Math.max(...bits) === plan.bits - 1);
  const perCoil = {};
  for (const b of plan.bitMap) if (b.coil != null) perCoil[b.coil] = (perCoil[b.coil] || 0) + 1;
  check('every coil gets exactly two frame bits (IN1 + IN2)',
    Object.keys(perCoil).length === C && Object.values(perCoil).every((n) => n === 2));

  const bp = buildDriverBackplane(sstat, scfg);
  check('backplane text is balanced with the chain emitted',
    (bp.text.match(/\(/g) || []).length === (bp.text.match(/\)/g) || []).length);
  const padNet = (text, name) => (text.match(new RegExp(`\\(pad [^\\n]*\\(net \\d+ "${name}"\\)`, 'g')) || []).length;
  let pwmOK = true, dataOK = true;
  for (let i = 0; i < C; i++) {
    if (padNet(bp.text, `PWMA_${i}`) !== 2 || padNet(bp.text, `PWMB_${i}`) !== 2) pwmOK = false;
  }
  check('every PWM net lands on exactly two pads (bridge input + 595 output)', pwmOK);
  for (let r = 0; r <= bp.stats.registers; r++) {
    if (padNet(bp.text, `DATA_${r}`) !== 2) dataOK = false;   // Q7S->DS links; ends reach the header
  }
  check('every chain link (and both chain ends) lands on exactly two pads', dataOK);
  check('the dead-man and the spine header are on the board',
    /reference "Q1"/.test(bp.text) && /reference "J1"/.test(bp.text));
  check('the backplane ships a contract', bp.contract && bp.contract.bitMap.length === bp.stats.chainBits);

  // The single-board build: electronics on B.Cu of the coil board itself, at
  // the fit-verified spots, with the same contract plus the sensor buses.
  const dcfg = { stator: { ...scfg.stator, statorSize: 0.048, pcbSpareLayers: 1 } };
  const dstat = makeStator({ ...dcfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const out = buildKiCad(dstat, dcfg, { sensorSpacing: 0.0216 });
  check('single-board export is balanced', (out.text.match(/\(/g) || []).length === (out.text.match(/\)/g) || []).length);
  check('one bridge per coil on the electronics layer (in the chosen package)',
    out.stats.drivers === dstat.coils.length
    && (out.text.match(/maglev:(SOP8HB|DFN8HB)/g) || []).length === dstat.coils.length
    && ['sop8', 'dfn8'].includes(out.stats.bridgePackage),
    `${out.stats.drivers} bridges as ${out.stats.bridgePackage}`);
  check('registers and sensors emitted match the stats',
    (out.text.match(/maglev:SR595/g) || []).length === out.stats.registers
    && (out.text.match(/maglev:TMAG/g) || []).length === out.stats.sensors && out.stats.sensors > 0);
  check('every register found a fit-searched spot', out.stats.registersUnplaced === 0);
  let sbPwmOK = true;
  for (let i = 0; i < dstat.coils.length; i++) {
    if (padNet(out.text, `PWMA_${i}`) !== 2 || padNet(out.text, `PWMB_${i}`) !== 2) sbPwmOK = false;
  }
  check('single-board PWM nets are each driven once and consumed once', sbPwmOK);
  check('the contract lists every sensor with its bus and address variant',
    out.contract.sensors.length === out.stats.sensors
    && out.contract.sensors.every((s, k) => s.bus === (k >> 2) && s.addrVariant === k % 4));
  // The export hands its plan back out (the worker posts it to the UI so the
  // as-placed observability check does not have to re-run the whole thing).
  check('buildKiCad returns the placement plan it emitted from',
    out.elec?.sensors?.list?.length === out.stats.sensors
    && out.elec.planStats.bridgePackage === out.stats.bridgePackage);
  // A passive board (no spare layer) must be unchanged in spirit: no parts.
  const pcfg = { stator: { ...scfg.stator, statorSize: 0.048 } };
  const pstat = makeStator({ ...pcfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const passive = buildKiCad(pstat, pcfg);
  check('a board with no electronics layer stays passive', passive.stats.drivers === 0 && !passive.contract);

  // --- DRC-lite: no two different-net copper items may overlap -------------
  // This is the check whose absence shipped a driver section full of stacked
  // pads: registers on bridges, sensors on vias, terminal pads drawn at the
  // wrong angle. Parse every pad, via and track back out of the emitted text,
  // reconstruct the copper exactly as KiCad draws it (footprints are emitted
  // unrotated; a pad's angle is literal, CCW in the y-up sense, so in file
  // coordinates the box rotates by MINUS the stated angle -- measured off
  // kicad-cli renders), and demand zero different-net overlaps.
  const parseCopper = (text) => {
    const pads = [], vias = [], tracks = [];
    const fpRe = /\(footprint "([^"]+)" \(layer "([^"]+)"\) \(at ([-\d.]+) ([-\d.]+)( [-\d.]+)?\)([\s\S]*?)\n  \)/g;
    let m;
    while ((m = fpRe.exec(text))) {
      const [, lib, layer, fx, fy, fAng, body] = m;
      if (fAng && Math.abs(+fAng) > 1e-9) pads.push({ err: `footprint ${lib} emitted with a rotation` });
      const padRe = /\(pad "[^"]*" smd rect \(at ([-\d.]+) ([-\d.]+)( [-\d.]+)?\) \(size ([-\d.]+) ([-\d.]+)\) \(layers "([^"]+)"[^)]*\)(?: \(clearance [-\d.]+\))? \(net (\d+)/g;
      let p;
      while ((p = padRe.exec(body))) {
        pads.push({ lib, side: p[6].split('.')[0], cx: +m[3] + +p[1], cy: +m[4] + +p[2],
          w: +p[4], h: +p[5], ang: -(+(p[3] ?? 0) * Math.PI) / 180, net: +p[7] });
      }
    }
    const viaRe = /\(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([-\d.]+)\)[^\n]*\(net (\d+)\)/g;
    while ((m = viaRe.exec(text))) vias.push({ x: +m[1], y: +m[2], r: +m[3] / 2, net: +m[4] });
    const segRe = /\(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([-\d.]+)\) \(layer "([^"]+)"\) \(net (\d+)\)/g;
    while ((m = segRe.exec(text))) {
      const [x0, y0, x1, y1, w] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
      tracks.push({ side: m[6].split('.')[0], cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
        w: Math.hypot(x1 - x0, y1 - y0) + w, h: w, ang: Math.atan2(y1 - y0, x1 - x0), net: +m[7] });
    }
    return { pads, vias, tracks };
  };
  const corners = (r) => {
    const c = Math.cos(r.ang), s = Math.sin(r.ang), hw = r.w / 2, hh = r.h / 2;
    return [[hw, hh], [hw, -hh], [-hw, -hh], [-hw, hh]]
      .map(([x, y]) => [r.cx + x * c - y * s, r.cy + x * s + y * c]);
  };
  const overlap = (a, b) => {
    for (const r of [a, b]) {
      for (const [ux, uy] of [[Math.cos(r.ang), Math.sin(r.ang)], [-Math.sin(r.ang), Math.cos(r.ang)]]) {
        const pa = corners(a).map(([x, y]) => x * ux + y * uy);
        const pb = corners(b).map(([x, y]) => x * ux + y * uy);
        if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
      }
    }
    return true;
  };
  const hitsVia = (r, v) => {
    const c = Math.cos(r.ang), s = Math.sin(r.ang), dx = v.x - r.cx, dy = v.y - r.cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const qx = Math.max(Math.abs(lx) - r.w / 2, 0), qy = Math.max(Math.abs(ly) - r.h / 2, 0);
    return qx * qx + qy * qy < v.r * v.r;
  };
  const drcLite = (text, name) => {
    const { pads, vias, tracks } = parseCopper(text);
    const bad = pads.filter((p) => p.err).map((p) => p.err);
    const rects = pads.filter((p) => !p.err).concat(tracks);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (a.side !== b.side || a.net === b.net) continue;
        if (Math.abs(a.cx - b.cx) > 12 || Math.abs(a.cy - b.cy) > 12) continue;
        if (overlap(a, b)) bad.push(`${a.lib ?? 'track'}[${a.net}] on ${b.lib ?? 'track'}[${b.net}] at (${a.cx.toFixed(1)},${a.cy.toFixed(1)})`);
      }
      for (const v of vias) {
        if (rects[i].net === v.net) continue;
        if (Math.abs(rects[i].cx - v.x) > 6 || Math.abs(rects[i].cy - v.y) > 6) continue;
        if (hitsVia(rects[i], v)) bad.push(`${rects[i].lib ?? 'track'}[${rects[i].net}] on via[${v.net}] at (${v.x.toFixed(1)},${v.y.toFixed(1)})`);
      }
    }
    check(`${name}: no two different-net copper items overlap`, bad.length === 0,
      bad.length ? `${bad.length} overlaps, e.g. ${bad[0]}` : `${rects.length} rects, ${vias.length} vias clean`);
  };
  drcLite(out.text, 'single-board');
  drcLite(bp.text, 'backplane');
  // And the terminal pads specifically: footprint unrotated, angle on the pad,
  // negated from the plan frame -- the exact combination that renders the
  // rectangle validatePcb approved.
  const term = /\(footprint "maglev:Term" \(layer "B.Cu"\) \(at [-\d.]+ [-\d.]+\)[\s\S]*?\(pad "1" smd rect \(at 0 0( [-\d.]+)?\)/.exec(out.text);
  check('terminal pads carry their rotation on the pad, not the footprint', !!term);
}

// The self-tileable outline: the board edge follows the coil-cell boundary, so
// abutted copies must continue the lattice exactly. That claim is checked the
// only way that matters -- translate the board by its own period and measure
// the seam: every cross-board nearest-neighbour spacing must be exactly one
// coil pitch, as if the seam were not there.
console.log('\n=== the full board tiles with itself ===');
{
  const { cellOutline, tileability, buildKiCad } = await import('../src/kicad.js');
  const hcfg = { stator: { ...cfg.stator, coilType: 'pcbhex', coilFill: 0.84, statorSize: 0.096 } };
  const hs = makeStator({ ...hcfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const t = tileability(hs, hcfg);
  check('the shipped hex board is self-tileable (even rows, seam copper clear)',
    t.tileable === true, `${t.nRows} rows, seam ${t.seamGapMm.toFixed(2)} mm`);

  const outline = cellOutline(hs, hcfg);
  check('the outline is a closed polygon of many cell edges', outline.length > 20);
  // Point-in-polygon: every coil centre is inside the outline.
  const inside = (px, py) => {
    let odd = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, yi] = outline[i], [xj, yj] = outline[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
  };
  check('every coil centre lies inside the outline',
    hs.coils.every((c) => inside(c.x * 1000, c.y * 1000)));

  // THE seam test. Tile the board at +periodX and at +periodY: across each
  // seam, every boundary coil's nearest neighbour on the other board must sit
  // at exactly one coil pitch -- no gap, no clash.
  const p = hcfg.stator.coilPitch * 1000;
  const seamOK = (dx, dy) => {
    let minD = Infinity;
    for (const a of hs.coils) {
      for (const b of hs.coils) {
        const d = Math.hypot(b.x * 1000 + dx - a.x * 1000, b.y * 1000 + dy - a.y * 1000);
        if (d > 1e-6 && d < minD) minD = d;
      }
    }
    return minD;
  };
  const dxMin = seamOK(t.periodXmm, 0);
  check('horizontal seam: the lattice continues at exactly one pitch',
    Math.abs(dxMin - p) < 1e-6, `nearest cross-board spacing ${dxMin.toFixed(6)} mm vs pitch ${p}`);
  const dyMin = seamOK(0, t.periodYmm);
  check('vertical seam: the lattice continues at exactly one pitch',
    Math.abs(dyMin - p) < 1e-6, `nearest cross-board spacing ${dyMin.toFixed(6)} mm vs pitch ${p}`);
  // And the regions must mesh without overlap. Interlocking outlines SHARE
  // boundary (that is what meshing means), so testing shifted vertices is
  // wrong -- the right statement for cell-union regions: no shifted CELL
  // CENTRE falls inside this board. Centres one pitch apart share a flat and
  // nothing more; a centre inside the outline would be a genuine collision.
  check('no shifted-board cell reaches inside this board (X seam)',
    hs.coils.every((c) => !inside(c.x * 1000 + t.periodXmm, c.y * 1000)));
  check('no shifted-board cell reaches inside this board (Y seam)',
    hs.coils.every((c) => !inside(c.x * 1000, c.y * 1000 + t.periodYmm)));

  // An odd-row hex board must be called out as vertically untileable.
  const odd = { stator: { ...hcfg.stator, statorSize: 0.090 } };  // 13 rows
  const os = makeStator({ ...odd.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const ot = tileability(os, odd);
  check('an odd-row honeycomb is reported vertically untileable',
    ot.nRows % 2 === 1 && ot.latticeY === false && ot.tileable === false, `${ot.nRows} rows`);

  // The square grid keeps its plain rectangle -- and is HONESTLY reported as
  // non-tiling, because its I/O pads straddle the cell boundary at high fill.
  const sqs = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
  const so = cellOutline(sqs, cfg);
  check('the square grid outline stays a plain rectangle', so.length === 4);
  const st2 = tileability(sqs, cfg);
  check('the square grid is honestly reported as not self-tiling (pads on the boundary)',
    st2.latticeX && st2.latticeY && st2.copperOK === false && st2.tileable === false,
    `seam ${st2.seamGapMm.toFixed(2)} mm`);

  // The export carries the verdict, and the hex board file has the castellated
  // edge, not a rectangle.
  const out = buildKiCad(hs, hcfg);
  check('the exported hex board has the cell-boundary outline',
    (out.text.match(/gr_line/g) || []).length > 20 && out.stats.tile.tileable === true);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall kicad checks pass');
process.exit(fails ? 1 : 0);
