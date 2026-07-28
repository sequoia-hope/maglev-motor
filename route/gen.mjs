// Generate the full amzhex coil board exactly the way the app does: same
// preset, same quality tier, same sensor spacing, same worker call sequence --
// just headless, writing the .kicad_pcb to disk instead of a download blob.
import { readFileSync, writeFileSync } from 'fs';
import { makeTranslator } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { stackUp, mechDefaultsFor, DEFAULT_MECH } from '../src/mechanical.js';
import { sensorLayout } from '../src/analysis.js';
import { buildKiCad, fabRuleFiles, pcbCoilGeometry } from '../src/kicad.js';

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');

// app.js QUALITY table (the preset asks for 'balanced').
const QUALITY = {
  fast: { segmentsPerSide: 2, ringsPerCoil: 1, maxOrder: 2 },
  balanced: { segmentsPerSide: 3, ringsPerCoil: 2, maxOrder: 3 },
  accurate: { segmentsPerSide: 5, ringsPerCoil: 3, maxOrder: 4 },
};

const key = process.argv[2] || 'amzhex';
const cfg = JSON.parse(JSON.stringify(PRESETS[key].cfg));
if (cfg.stator.pcbSpareLayers == null) cfg.stator.pcbSpareLayers = 0;
if (process.env.SPARE) cfg.stator.pcbSpareLayers = +process.env.SPARE;
if (process.env.LAYERS) cfg.stator.pcbLayers = +process.env.LAYERS;
const q = QUALITY[cfg.sim.quality];

cfg.mech = mechDefaultsFor(cfg, DEFAULT_MECH);
const stack = stackUp(cfg, cfg.mech);
const tr = makeTranslator({
  ...cfg.translator,
  platenMass: cfg.translator.platenMass || stack.platenMass,
  gap: cfg.sim.gap,
  maxOrder: q.maxOrder,
});
const stator = makeStator({ ...cfg.stator, ringsPerCoil: q.ringsPerCoil, segmentsPerSide: q.segmentsPerSide });

const layout = sensorLayout(stator, tr, { gap: cfg.sim.gap, maxTilt: cfg.sim.maxTilt });
const sensorSpacing = cfg.stator.pcbSpareLayers > 0 && layout.available ? layout.spacing : null;
console.log(`sensor spacing: ${sensorSpacing == null ? 'none' : (sensorSpacing * 1000).toFixed(2) + ' mm'}`);

const t0 = Date.now();
// BRIDGE=sop8 pins the bridge package instead of letting backsideFit choose --
// the SO-8 / SOT-23-6 routing comparison.
const kc = buildKiCad(stator, cfg, { sensorSpacing, forceBridge: process.env.BRIDGE || null });
console.log(`built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(kc.stats, null, 2));

// OUT_KEY writes under a different basename than the preset, so a variant build
// does not clobber the board a routing run is already grinding on.
const outKey = process.env.OUT_KEY || key;
const out = new URL(`./${outKey}.kicad_pcb`, import.meta.url);
writeFileSync(out, kc.text);
writeFileSync(new URL(`./${outKey}.contract.json`, import.meta.url), JSON.stringify(kc.contract, null, 2));
// The rule files go beside the board under the same basename -- that is where
// kicad-cli looks for them -- and they are generated from FAB, so what DRC
// checks is what the geometry was sized from.
const rules = fabRuleFiles({ trackWidth: pcbCoilGeometry(cfg).trace });
writeFileSync(new URL(`./${outKey}.kicad_dru`, import.meta.url), rules.dru);
writeFileSync(new URL(`./${outKey}.kicad_pro`, import.meta.url), rules.pro);
console.log(`wrote ${out.pathname} (${(kc.text.length / 1e6).toFixed(1)} MB)`);
