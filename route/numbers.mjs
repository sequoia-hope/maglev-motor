// The numbers the amzhex blurb quotes, recomputed from the same code the UI
// runs. Coil fill and the electronics-layer count both changed, so every
// winding-derived figure in that prose moved with them.
import { readFileSync } from 'fs';
import { makeTranslator } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { stackUp, mechDefaultsFor, DEFAULT_MECH } from '../src/mechanical.js';
import { analysePose } from '../src/physics.js';
import { thermal } from '../src/analysis.js';
import { quat } from '../src/math.js';
import { pcbCoilGeometry, viaSize, viaDrill, gutterFits } from '../src/kicad.js';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const Q = { balanced: { segmentsPerSide: 3, ringsPerCoil: 2, maxOrder: 3 } };

const key = process.argv[2] || 'amzhex';
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));
if (cfg.stator.pcbSpareLayers == null) cfg.stator.pcbSpareLayers = 0;
const q = Q[cfg.sim.quality] || Q.balanced;
cfg.mech = mechDefaultsFor(cfg, DEFAULT_MECH);
const stack = stackUp(cfg, cfg.mech);
const tr = makeTranslator({ ...cfg.translator, platenMass: cfg.translator.platenMass || stack.platenMass, gap: cfg.sim.gap, maxOrder: q.maxOrder });
const stator = makeStator({ ...cfg.stator, ringsPerCoil: q.ringsPerCoil, segmentsPerSide: q.segmentsPerSide });

const at = (x, y, yawDeg = 0) => analysePose(
  stator, tr, [x, y, cfg.sim.gap],
  yawDeg ? [Math.cos((yawDeg * Math.PI) / 360), 0, 0, Math.sin((yawDeg * Math.PI) / 360)] : quat.identity(),
  cfg.sim.iMax, cfg.sim.grouping);

const g = pcbCoilGeometry(cfg);
const cellHalf = cfg.stator.coilPitch * 1000 / 2;
const v = viaSize(g, cellHalf);

const travel = (cfg.stator.statorSize - cfg.translator.platenSize) / 2;
// The blurb quotes a +/-16 mm workspace, so grade that box, not the full travel.
const box = +(process.env.BOX || 0.016);
const corners = [[box, box], [-box, box], [box, -box], [-box, -box]];
const centre = at(0, 0);
let worst = centre, worstYaw = at(0, 0, 45);
for (const [x, y] of corners) {
  const a = at(x, y);
  if (a.liftMargin < worst.liftMargin) worst = a;
  const b = at(x, y, 45);
  if (b.liftMargin < worstYaw.liftMargin) worstYaw = b;
}
const area = cfg.stator.statorSize ** 2;

console.log(JSON.stringify({
  coils: stator.coils.length,
  windingLayers: g.layers,
  physicalLayers: g.physLayers,
  turnsPerLayer: g.turns,
  turnsTotal: stator.effTurns,
  coilFill: cfg.stator.coilFill,
  traceMm: g.trace,
  viaMm: +v.toFixed(3),
  viaDrillMm: +viaDrill(v, g.thickness).toFixed(3),
  ringMm: +((v - viaDrill(v, g.thickness)) / 2).toFixed(3),
  gutterMm: +gutterFits(g, cellHalf).have.toFixed(3),
  resistanceOhm: +stator.coils[0].R.toFixed(2),
  boardThicknessMm: +(stator.thickness * 1000).toFixed(2),
  platenMassG: +(tr.mass * 1000).toFixed(1),
  iMax: cfg.sim.iMax,
  busVoltsAtIMax: +(cfg.sim.iMax * stator.coils[0].R).toFixed(1),
  liftCentre: +centre.liftMargin.toFixed(2),
  liftWorstCorner: +worst.liftMargin.toFixed(2),
  liftWorstYaw45: +worstYaw.liftMargin.toFixed(2),
  hoverPeakAmp: +centre.hoverPeakCurrent.toFixed(3),
  hoverPowerCentreW: +centre.hoverPower.toFixed(2),
  hoverPowerWorstW: +worst.hoverPower.toFixed(2),
  hoverPeakVolts: +(centre.hoverPeakCurrent * stator.coils[0].R).toFixed(2),
  currentDensityPeak: +(centre.hoverPeakCurrent / stator.wireArea / 1e6).toFixed(0),
  tempRiseK: +thermal(worst.hoverPower, area).toFixed(1),
  workspaceHalfMm: box * 1000,
  fullTravelHalfMm: +(travel * 1000).toFixed(1),
}, null, 1));
