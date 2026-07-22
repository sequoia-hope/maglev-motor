// App shell: parameter UI, design analyses, and the real-time flight loop.

import { quat, clamp } from './math.js';
import {
  ARRAY_TYPES, makeTranslator, selfTest,
  applyMagnetDrive, nearestStockMagnet, STOCK_MAGNET_SIZES, arraySymmetry, imperialName,
} from './halbach.js';
import { COIL_TYPES, makeStator } from './coils.js';
import { buildKiCad } from './kicad.js';
import { analysePose, buildWrench, groupWrench, allocatePrioritised, copperLoss, makeState, step } from './physics.js';
import { GROUPINGS, buildGrouping } from './grouping.js';
import { makeController, control, TRAJECTORIES, makeDisturbance, applyDisturbance, kick } from './control.js';
import { render, makeCamera, fitCamera, attachOrbit, theme } from './render3d.js';
import { lineChart, heatmap, barStrip, trackHover } from './plots.js';
import { fieldMap, liftVsGap, pitchSweep, capabilityMap, rippleScan } from './analysis.js';
import { MATERIALS, PROCESSES, COOLING, DEFAULT_MECH, stackUp, stackTemperatureRise, mechDefaultsFor } from './mechanical.js';
import { buildAssembly } from './assembly.js';
import { renderExploded } from './exploded.js';

// ---------------------------------------------------------------- presets ---

const PRESETS = {
  amz316: {
    label: '3/16" cubes, one part number (Amazing Magnets)',
    blurb: 'Every magnet is the same catalogue part: Amazing Magnets C188A2-N52, a 3/16" N52 cube at $0.56 each — 85 magnets in 121 pockets, $47.60 of magnet for the whole platen (25 axial, 60 in-plane, 0 custom). Their cubes are sold magnetised through the thickness only, but a true cube rotates 90° to give an in-plane dipole with the same footprint, so the axial blocks and the flux-steering blocks are the SAME SKU turned in the jig. λ = 19.05 mm because that is 4 × 3/16", not because anything chose it. 11×11 symmetric array, 52.4 mm platen, 225 hand-wound coils on a 94 mm stator, 16 amplifiers on 2×2 commutation regions, and a 2.5 mm gap over a 0.56 mm tolerance floor. Amazing Magnets themselves stock imperial only, so the 5 mm preset is not orderable from THEM — but 5 mm cubes are easy to get elsewhere (Amazon), so both sizes are live options rather than one ruling out the other.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single',
        driveByMagnet: true, cubicMagnets: true, magnetSize: 0.0047625,
        pitch: 0.01905, magnetThickness: 0.0047625, Br: 1.45, segments: 4,
        platenSize: 0.0523875, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.00635, coilFill: 0.92, statorSize: 0.094, windingHeight: 0.004, wireDiameter: 0.0002, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.0025, iMax: 7.5, bwPos: 18, bwAtt: 34, zeta: 1.0, kiPos: 0.5, kiAtt: 0.5, maxTilt: 0.06, quality: 'balanced', grouping: 'r2' },
    },
  },
  cube5: {
    label: '5 mm cubes (nothing custom)',
    blurb: 'Designed backwards from the shopping list: 133 plain 5 mm N42 cubes, no custom magnetisation, no ground-to-size blocks. Four cubes per wavelength is the only stock-magnetised choice, so λ = 20 mm is not a variable — it is what 5 mm cubes give you. Everything else was searched around it: 225 hand-wound coils, 2.2 mm gap with 1.6 mm of tolerance margin under it. The platen is 65 mm because that is 13 cells exactly: a symmetric array needs an odd number of cells, and the 65.0 mm array wastes no border at all, where 60 mm would have given up a cell on each side and carried only 85 cubes.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single',
        driveByMagnet: true, cubicMagnets: true, magnetSize: 0.005,
        pitch: 0.020, magnetThickness: 0.005, Br: 1.32, segments: 4,
        platenSize: 0.065, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.0078, coilFill: 0.92, statorSize: 0.120, windingHeight: 0.004, wireDiameter: 0.0003, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: true },
      sim: { gap: 0.0022, iMax: 7.5, bwPos: 18, bwAtt: 34, zeta: 1.0, kiPos: 0.5, kiAtt: 0.5, maxTilt: 0.06, quality: 'balanced', grouping: 'r2' },
    },
  },
  desk40: {
    label: '40 mm desktop platen (searched)',
    blurb: 'Found by the optimiser: a 40 mm 2-D Halbach platen over hand-wound square coils, maximising air gap subject to 3x lift, 35 K rise and 12 A/mm². 33 magnets in 49 pockets, 144 coils, 36 amplifiers, 2.49 mm gap. The winding is the work: 520 m of 0.2 mm wire. The symmetric lattice suits this one: 7×7 cells, 36.6 mm across on a 40 mm platen, where the old boundary-anchored grid managed only 6×6 and 27 magnets.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single', pitch: 0.0209, magnetThickness: 0.002, Br: 1.32, segments: 4, platenSize: 0.040, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.00677, coilFill: 0.92, statorSize: 0.080, windingHeight: 0.0038, wireDiameter: 0.0002, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.00249, iMax: 7.5, bwPos: 20, bwAtt: 38, zeta: 1.0, kiPos: 0.5, kiAtt: 0.5, maxTilt: 0.06, quality: 'balanced', grouping: 'r3' },
    },
  },
  pcb: {
    label: 'PCB stage (buildable)',
    blurb: 'A 72 mm 2-D Halbach platen over a PCB stator, no coil winding. Layer count is the whole design problem here. Every layer buys turns but also thickens the board, sinking the copper centroid into a field that decays as exp(−2π·z/λ) — and past 12 layers the board is prohibitively expensive to fabricate anyway, so 12 is a hard ceiling, not a slider you push. That ceiling is why the platen has to stay small and light: with only 12 layers of 5 oz (175 µm) copper the board cannot make enough force to fly a heavy platen at a manufacturable gap. At 72 mm and λ = 36 mm it works — a 3.25 mm board of 144 spirals grouped into 36 amplifiers, passing every default constraint at a 2.0 mm gap over a 1.78 mm floor: 7.2× lift, 6.5 W hover, 13 K rise. The binding limit is current density, 13.9 A/mm² against the 15 A/mm² line — thin traces carrying real hover current is what caps this topology, which is why it flies with lift margin to spare but no room to shrink the copper. For a lighter, cheaper build see the small PCB stage.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single', pitch: 0.036, magnetThickness: 0.004, Br: 1.43, segments: 4, platenSize: 0.072, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'pcb', coilPitch: 0.012, coilFill: 0.94, statorSize: 0.144, windingHeight: 0.0016, wireDiameter: 0.0005, pcbLayers: 12, pcbTraceWidth: 0.0001, pcbCopperThickness: 175e-6, lockCoilPitch: false },
      sim: { gap: 0.002, iMax: 5, bwPos: 22, bwAtt: 40, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced', grouping: 'r3' },
    },
  },
  pcbmini: {
    label: 'PCB stage (small)',
    blurb: 'The smallest PCB build that still flies: a 48 mm 2-D Halbach platen on a 24 mm pole pitch, 6 mm cells. Same recipe as the larger PCB stage — a 12-layer board (the fabrication cost ceiling), 5 oz copper, 144 spirals, 36 amplifiers — but a lighter platen needs less force, so it closes at a tighter 1.5 mm gap over a 1.30 mm floor with 108 turns per spiral instead of 168. It passes every default constraint: 5.6× lift, 3.0 W hover, 14 K rise, and it is current-density limited at 14.4 A/mm² against the 15 A/mm² line, the same wall the larger board hits. λ = 24 mm makes 6 mm cells, so the 48 mm platen is 8 cells across and carries 33 magnets in a 7×7 lattice with the pattern nulls left empty. This is the cheapest way onto the topology; the larger stage buys stroke and payload for a bigger, hotter board.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.003, Br: 1.43, segments: 4, platenSize: 0.048, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.096, windingHeight: 0.0016, wireDiameter: 0.0005, pcbLayers: 12, pcbTraceWidth: 0.0001, pcbCopperThickness: 175e-6, lockCoilPitch: false },
      sim: { gap: 0.0015, iMax: 4, bwPos: 22, bwAtt: 40, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced', grouping: 'r3' },
    },
  },
  wound: {
    label: 'Hand-wound square coils (Zhu/Teo/Pang)',
    blurb: 'Four 1-D Halbach arrays in a cross, thrusting tangentially, over a grid of square coils. Driven as the published eight-phase scheme: 8 amplifiers for ~120 live coils, full 6-DOF.',
    cfg: {
      translator: { arrayType: 'halbach1d', layout: 'quad', pitch: 0.040, magnetThickness: 0.010, Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.0133, coilFill: 0.92, statorSize: 0.30, windingHeight: 0.010, wireDiameter: 0.0004, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.003, iMax: 6, bwPos: 16, bwAtt: 30, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced', grouping: 'r1' },
    },
  },
  racetrack: {
    label: 'Racetrack stator (Jansen / ASML)',
    blurb: 'Two orthogonal banks of segmented, staggered rectangular coils under a 2-D Halbach platen — the topology real lithography stages use. Fewest coils per unit area, but it runs hot and is the one preset that will NOT tolerate phase grouping: switch the drive to 3x3 regions and watch worst-case lift fall below 1x weight.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single', pitch: 0.050, magnetThickness: 0.003, Br: 1.43, segments: 4, platenSize: 0.12, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'racetrack', coilPitch: 0.0167, coilFill: 0.9, statorSize: 0.30, windingHeight: 0.009, wireDiameter: 0.0006, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.0015, iMax: 8, bwPos: 14, bwAtt: 26, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced', grouping: 'independent' },
    },
  },
  baseline: {
    label: 'Baseline: plain N/S array',
    blurb: 'Identical machine with the flux-steering magnets removed. Run it to see exactly what the Halbach geometry buys you.',
    cfg: {
      translator: { arrayType: 'alternating', layout: 'single', pitch: 0.040, magnetThickness: 0.010, Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.0133, coilFill: 0.92, statorSize: 0.30, windingHeight: 0.010, wireDiameter: 0.0004, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.003, iMax: 6, bwPos: 16, bwAtt: 30, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced', grouping: 'r2' },
    },
  },
};

const QUALITY = {
  fast: { segmentsPerSide: 2, ringsPerCoil: 1, maxOrder: 2, controlHz: 400, label: 'Fast' },
  balanced: { segmentsPerSide: 3, ringsPerCoil: 2, maxOrder: 3, controlHz: 600, label: 'Balanced' },
  accurate: { segmentsPerSide: 5, ringsPerCoil: 3, maxOrder: 4, controlHz: 1000, label: 'Accurate' },
};

// ----------------------------------------------------------- param schema ---

const mm = { scale: 1000, unit: 'mm', digits: 1 };
const PARAMS = [
  {
    title: 'Magnet array (translator)',
    fields: [
      { path: 'translator.arrayType', type: 'select', label: 'Array topology',
        options: Object.entries(ARRAY_TYPES).map(([k, v]) => [k, v.label]),
        help: (cfg) => ARRAY_TYPES[cfg.translator.arrayType].note },
      { path: 'translator.layout', type: 'select', label: 'Platen layout',
        options: [['single', 'One continuous array'], ['quad', 'Four arrays in a cross']],
        help: () => 'A cross of four 1-D arrays is the classic way to get all six DOF from single-axis Halbach strips. A single 2-D array does it alone.' },
      { path: 'translator.driveByMagnet', type: 'check', label: 'Design around a stock magnet',
        help: () => 'Off, you choose a pole pitch and the cell size is whatever λ/M happens to be — usually a number no supplier stocks, so every block is a custom grind. On, the magnet is the input and the pitch is the consequence: λ = size × M, in steps rather than continuously. That step is real, not a modelling limitation.' },
      { path: 'translator.magnetSize', type: 'range', label: 'Magnet size (square cell)',
        min: 0.002, max: 0.025, step: 0.001, ...mm, digits: 1,
        show: (c) => c.translator.driveByMagnet,
        help: (c) => {
          const s = c.translator.magnetSize, n = nearestStockMagnet(s);
          const stock = Math.abs(n - s) < 1e-9;
          const inch = imperialName(s);
          // Naming the inch fraction matters: US distributors stock no metric
          // cubes at all, so "4.8 mm" is a number you cannot put on an order and
          // 3/16" is the same part with a SKU behind it.
          return `${stock ? `Catalogue size${inch ? ` — ${inch} cube` : ' (metric)'}` : `Not a stock size — nearest is ${(n * 1000).toFixed(2)} mm${imperialName(n) ? ` (${imperialName(n)})` : ''}`}. `
            + `Stocked, mm: ${STOCK_MAGNET_SIZES.map((v) => (v * 1000).toFixed(v < 0.005 ? 2 : 1)).join(', ')}. `
            + `Imperial sizes are the ones a US supplier actually carries. `
            + `With ${c.translator.segments} per wavelength this gives λ = ${(s * c.translator.segments * 1000).toFixed(1)} mm.`;
        } },
      { path: 'translator.cubicMagnets', type: 'check', label: 'Cube stock (thickness = width)',
        show: (c) => c.translator.driveByMagnet,
        help: () => 'Cubes are the cheapest thing on the shelf and the easiest to orient in a jig, but they tie thickness to pitch: you cannot thin the array without also shortening the wavelength. Turn this off to buy blocks and choose the thickness separately.' },
      { path: 'translator.pitch', type: 'range', label: 'Pole pitch λ', min: 0.008, max: 0.080, step: 0.001, ...mm,
        disabled: (c) => c.translator.driveByMagnet,
        help: (c) => (c.translator.driveByMagnet
          ? `Derived: ${(c.translator.magnetSize * 1000).toFixed(1)} mm × ${c.translator.segments} = ${(c.translator.pitch * 1000).toFixed(1)} mm. Change the magnet or the segment count to move it.`
          : 'The dominant design variable. Air-gap field decays as exp(−2πz/λ), so usable flying height scales directly with pitch.') },
      { path: 'translator.segments', type: 'range', label: 'Magnets per wavelength', min: 2, max: 8, step: 1, scale: 1, unit: '', digits: 0,
        help: (c) => 'Discretisation of the ideal rotating magnetisation. Amplitude penalty is sin(π/M)/(π/M): 0.64 at M=2, 0.90 at M=4, 0.96 at M=6.'
          + (c.translator.driveByMagnet ? ' With the magnet fixed this is your only pitch control, and it moves λ a whole magnet at a time.' : '') },
      { path: 'translator.magnetThickness', type: 'range', label: 'Magnet thickness', min: 0.002, max: 0.030, step: 0.001, ...mm,
        disabled: (c) => c.translator.driveByMagnet && c.translator.cubicMagnets,
        help: (c) => (c.translator.driveByMagnet && c.translator.cubicMagnets
          ? 'Locked to the cube edge. Uncheck "cube stock" to buy blocks and set it independently.'
          : 'Diminishing returns past about λ/4: the (1−exp(−k·D)) term saturates.') },
      { path: 'translator.Br', type: 'range', label: 'Remanence Br', min: 0.4, max: 1.45, step: 0.01, scale: 1, unit: 'T', digits: 2,
        help: () => 'N52 NdFeB ≈ 1.43 T, N42 ≈ 1.32 T, SmCo ≈ 1.05 T, ferrite ≈ 0.4 T.' },
      { path: 'translator.platenSize', type: 'range', label: 'Platen size', min: 0.03, max: 0.30, step: 0.005, ...mm },
      { path: 'translator.platenMass', type: 'range', label: 'Platen mass (0 = auto)', min: 0, max: 5, step: 0.01, scale: 1000, unit: 'g', digits: 0,
        help: () => `Leave at 0 and the mass comes from the parts list: ${sig(app.stack.magnetMass * 1000, 3)} g of magnets, `
          + `${sig(app.stack.pocketMass * 1000, 3)} g retainer, ${sig(app.stack.backingMass * 1000, 3)} g backing plate, plus adhesive. See the Build tab.` },
    ],
  },
  {
    title: 'Coil array (stator)',
    fields: [
      { path: 'stator.coilType', type: 'select', label: 'Coil topology',
        options: Object.entries(COIL_TYPES).map(([k, v]) => [k, v.label]),
        help: (cfg) => COIL_TYPES[cfg.stator.coilType].note },
      { path: 'stator.coilPitch', type: 'range', label: 'Coil pitch', min: 0.002, max: 0.060, step: 0.001, ...mm,
        help: (c) => `Use λ/3 (${(c.translator.pitch / 3 * 1000).toFixed(1)} mm here). At exactly λ/2 the coil grid lands in phase with the magnets and lateral force cancels identically at symmetric poses — watch the capability map collapse if you try it.` },
      { path: 'stator.coilFill', type: 'range', label: 'Coil fill fraction', min: 0.5, max: 1.0, step: 0.01, scale: 100, unit: '%', digits: 0 },
      { path: 'stator.statorSize', type: 'range', label: 'Stator size', min: 0.05, max: 0.6, step: 0.01, ...mm },
      { path: 'stator.windingHeight', type: 'range', label: 'Winding build height', min: 0.001, max: 0.020, step: 0.0005, ...mm, digits: 1,
        show: (c) => c.stator.coilType !== 'pcb',
        help: () => 'How tall the winding stands off the board. Turn count is DERIVED from this and the wire gauge (70% packing) — you cannot ask for turns that do not fit. Taller means more turns but also more air gap consumed.' },
      { path: 'stator.wireDiameter', type: 'range', label: 'Wire diameter', min: 0.0002, max: 0.002, step: 0.00005, scale: 1000, unit: 'mm', digits: 2,
        show: (c) => c.stator.coilType !== 'pcb',
        help: (c) => `Thicker wire cuts copper loss but fewer turns fit, and force is proportional to turns. Current build: ${app.stator ? app.stator.effTurns : '?'} turns per coil.` },
      { path: 'stator.pcbLayers', type: 'range', label: 'PCB copper layers', min: 2, max: 32, step: 2, scale: 1, unit: '', digits: 0,
        show: (c) => c.stator.coilType === 'pcb',
        help: () => `Layers are the only way to buy turns on a PCB stator, but they are not free: the board grows `
          + `${app.stator ? (app.stator.thickness * 1000).toFixed(2) : '?'} mm thick here, and the copper centroid sinks with it. `
          + `Past a point the extra layers sit too deep in the field to pay for themselves — watch lift margin, not turn count. `
          + `And past 12 layers the board gets prohibitively expensive to fabricate, so the optimiser will not go there even though this slider will.` },
      { path: 'stator.pcbTraceWidth', type: 'range', label: 'Trace width', min: 0.0001, max: 0.001, step: 0.00001, scale: 1000, unit: 'mm', digits: 3,
        show: (c) => c.stator.coilType === 'pcb',
        help: () => 'The conductor width. An equal space is assumed beside it, so the turn pitch is twice this — quote it to a fab as "trace/space". '
          + '0.1 mm is standard, 0.075 mm is cheap-fab advanced, below that gets expensive fast.' },
      { path: 'stator.pcbCopperThickness', type: 'range', label: 'Copper weight', min: 17.5e-6, max: 210e-6, step: 17.5e-6, scale: 1e6, unit: 'µm', digits: 0,
        show: (c) => c.stator.coilType === 'pcb',
        help: () => '35 µm = 1 oz, 70 µm = 2 oz. This sets your resistance and therefore your thermal ceiling.' },
    ],
  },
  {
    title: 'Mechanical build',
    fields: [
      { path: 'mech.backingThickness', type: 'range', label: 'Platen backing plate', min: 0.001, max: 0.020, step: 0.0005, ...mm, digits: 1,
        help: () => 'Carries the magnet retainer. Thicker is stiffer and flatter but every gram is lift you have to pay for.' },
      { path: 'mech.backingMaterial', type: 'select', label: 'Backing material',
        options: Object.entries(MATERIALS).map(([k, v]) => [k, v.label]),
        help: (c) => `${MATERIALS[c.mech.backingMaterial].rho} kg/m³, CTE ${(MATERIALS[c.mech.backingMaterial].cte * 1e6).toFixed(1)} ppm/K. CFRP is the classic platen material: a third the expansion of aluminium at 60% the density.` },
      { path: 'mech.pocketWall', type: 'range', label: 'Magnet retainer wall', min: 0.0002, max: 0.003, step: 0.0001, scale: 1000, unit: 'mm', digits: 2,
        help: () => 'Wall between magnet cells. Halbach neighbours push hard, so this wall is structural — but it displaces magnet, so it costs field directly.' },
      { path: 'mech.baseProcess', type: 'select', label: 'Stator flatness class',
        options: Object.entries(PROCESSES).map(([k, v]) => [k, v.label]),
        help: (c) => `${PROCESSES[c.mech.baseProcess].note}. This is usually the largest single term in the air-gap budget.` },
      { path: 'mech.spreaderThickness', type: 'range', label: 'Thermal spreader', min: 0, max: 0.012, step: 0.0005, ...mm, digits: 1 },
      { path: 'mech.cooling', type: 'select', label: 'Cooling',
        options: Object.entries(COOLING).map(([k, v]) => [k, v.label]),
        help: (c) => `h = ${COOLING[c.mech.cooling].h} W/m²K. Cooling buys current density, and current density is force.` },
      { path: 'mech.controlError', type: 'range', label: 'Control error (3σ)', min: 0.00001, max: 0.001, step: 0.00001, scale: 1e6, unit: 'µm', digits: 0,
        help: () => 'Goes straight into the air-gap budget: you cannot fly closer than you can hold position. The Simulate tab measures this — see the readout there.' },
      { path: 'mech.gapSafety', type: 'range', label: 'Gap safety margin', min: 0, max: 1, step: 0.05, scale: 100, unit: '%', digits: 0 },
    ],
  },
  {
    title: 'Operating point',
    fields: [
      { path: 'sim.gap', type: 'range', label: 'Nominal air gap', min: 0.0005, max: 0.030, step: 0.0005, ...mm, digits: 2 },
      { path: 'sim.iMax', type: 'range', label: 'Current limit per coil', min: 0.2, max: 30, step: 0.1, scale: 1, unit: 'A', digits: 1 },
      { path: 'sim.grouping', type: 'select', label: 'Drive / phase grouping',
        options: Object.entries(GROUPINGS).map(([k, v]) => [k, v.label]),
        help: (c) => `${GROUPINGS[c.sim.grouping].note}${app.analysis ? ` Currently ${app.analysis.amplifiers} amplifier${app.analysis.amplifiers === 1 ? '' : 's'} for ${app.analysis.activeCoils} live coils.` : ''}` },
      { path: 'sim.quality', type: 'select', label: 'Solver quality',
        options: Object.entries(QUALITY).map(([k, v]) => [k, v.label]),
        help: (c) => `${QUALITY[c.sim.quality].controlHz} Hz control rate, harmonics to order ${QUALITY[c.sim.quality].maxOrder}, ${QUALITY[c.sim.quality].segmentsPerSide * 4 * QUALITY[c.sim.quality].ringsPerCoil} filaments per coil.` },
    ],
  },
  {
    title: 'Controller',
    fields: [
      { path: 'sim.bwPos', type: 'range', label: 'Position bandwidth', min: 2, max: 80, step: 1, scale: 1, unit: 'rad/s', digits: 0,
        help: () => 'Maglev has zero passive stiffness, so all of it comes from here. Push it until the loop starts fighting the current limit.' },
      { path: 'sim.bwAtt', type: 'range', label: 'Attitude bandwidth', min: 4, max: 150, step: 1, scale: 1, unit: 'rad/s', digits: 0 },
      { path: 'sim.zeta', type: 'range', label: 'Damping ratio', min: 0.3, max: 2.0, step: 0.05, scale: 1, unit: '', digits: 2 },
      { path: 'sim.kiPos', type: 'range', label: 'Integral action (pos)', min: 0, max: 2, step: 0.05, scale: 1, unit: '', digits: 2 },
      { path: 'sim.kiAtt', type: 'range', label: 'Integral action (att)', min: 0, max: 2, step: 0.05, scale: 1, unit: '', digits: 2 },
    ],
  },
];

// ------------------------------------------------------------------ state ---

const app = {
  presetKey: 'desk40',
  cfg: null,
  tr: null,
  stator: null,
  analysis: null,
  state: null,
  ctrl: null,
  dist: makeDisturbance(),
  camDesign: makeCamera(),
  camSim: makeCamera(),
  camExp: makeCamera(),
  viewExp: { explode: 1, zScale: 1 },
  view: { section: { axis: 'none', frac: 0.5 }, zScale: 1 },
  viewSim: { section: { axis: 'none', frac: 0.5 }, zScale: 1 },
  running: true,
  tab: 'design',
  traj: 'hover',
  trajParams: { gap: 0.0015, amplitude: 0.025, speed: 2, tiltAmp: 0.02 },
  hist: null,
  charts: new Map(),
  pitchRows: null,
  lastFrame: 0,
};

const deep = (o) => JSON.parse(JSON.stringify(o));
const get = (o, path) => path.split('.').reduce((a, k) => a[k], o);
const set = (o, path, v) => {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
};

function loadPreset(key) {
  app.presetKey = key;
  // The dropdown is a view of presetKey, not a second copy of it. Setting it
  // here is what stops the boot preset and the label above it from disagreeing
  // -- which they did, silently, the moment the default stopped being the first
  // entry in PRESETS.
  const sel = document.getElementById('presetSelect');
  if (sel && sel.value !== key) sel.value = key;
  app.cfg = deep(PRESETS[key].cfg);
  if (!app.cfg.mech) app.cfg.mech = mechDefaultsFor(app.cfg, DEFAULT_MECH);
  rebuild(true);
  buildParamUI();
}

function rebuild(resetSim = false) {
  // Before anything reads pitch or thickness. A magnet-driven config has no
  // independent pole pitch, and letting a stale one through would build a
  // translator whose cells are not the size of the magnets in the BOM.
  applyMagnetDrive(app.cfg.translator);
  const q = QUALITY[app.cfg.sim.quality];
  if (!app.cfg.mech) app.cfg.mech = mechDefaultsFor(app.cfg, DEFAULT_MECH);
  // Mechanical stack first: it supplies the platen mass the physics needs.
  app.stack = stackUp(app.cfg, app.cfg.mech);
  app.tr = makeTranslator({
    ...app.cfg.translator,
    platenMass: app.cfg.translator.platenMass || app.stack.platenMass,
    gap: app.cfg.sim.gap,
    maxOrder: q.maxOrder,
  });
  app.stator = makeStator({
    ...app.cfg.stator,
    ringsPerCoil: q.ringsPerCoil,
    segmentsPerSide: q.segmentsPerSide,
  });
  app.analysis = analysePose(
    app.stator, app.tr, [0, 0, app.cfg.sim.gap], quat.identity(),
    app.cfg.sim.iMax, app.cfg.sim.grouping);
  app.pitchRows = null;
  app.trajParams.gap = app.cfg.sim.gap;
  // Second pass: the tolerance stack's thermal-growth term depends on the
  // temperature rise, which depends on the design we just built.
  app.stack = stackUp(app.cfg, { ...app.cfg.mech, deltaT: stackTemperatureRise(app.analysis.hoverPower, app.stack) });
  app.assembly = buildAssembly(app.cfg, app.stack, app.tr, app.stator);
  for (const cam of [app.camDesign, app.camSim]) {
    fitCamera(cam, app.cfg.stator.statorSize, app.cfg.translator.platenSize, app.cfg.sim.gap);
  }
  // The exploded view is taller than the machine and carries a label column, so
  // it needs to sit further back and look from lower down.
  fitCamera(app.camExp, app.cfg.stator.statorSize, app.cfg.translator.platenSize, app.cfg.sim.gap);
  if (!app.camExp.userZoomed) app.camExp.dist *= 1.15;

  if (resetSim || !app.state) resetSimulation();
  app.ctrl = makeController(app.cfg.sim);
  redrawAll();
}

function resetSimulation() {
  app.state = makeState(app.tr, app.cfg.sim.gap);
  app.ctrl = makeController(app.cfg.sim);
  app.dist = makeDisturbance();
  app.dist.noise = +document.getElementById('noiseSlider').value;
  app.hist = { t: [], ex: [], ey: [], ez: [], ax: [], ay: [], az: [], ip: [], pw: [], trail: [] };
}

// --------------------------------------------------------------- param UI ---

function buildParamUI() {
  const root = document.getElementById('params');
  root.innerHTML = '';
  for (const g of PARAMS) {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = `<h3>${g.title}</h3>`;
    for (const f of g.fields) div.appendChild(makeField(f));
    root.appendChild(div);
  }
  refreshFieldVisibility();
}

function makeField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.path = f.path;
  const val = get(app.cfg, f.path);

  if (f.type === 'select') {
    wrap.innerHTML = `<div class="row"><label>${f.label}</label></div>
      <select>${f.options.map(([k, l]) => `<option value="${k}"${k === val ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="help"></div>`;
    const sel = wrap.querySelector('select');
    sel.addEventListener('change', () => {
      set(app.cfg, f.path, sel.value);
      rebuild(f.path === 'sim.quality' ? false : true);
      refreshFieldVisibility();
      updateHelp();
      if (typeof syncOptConstraints === 'function') { syncOptConstraints(); refreshOptDimStates(); }
    });
  } else if (f.type === 'check') {
    wrap.innerHTML = `<div class="row"><label><input type="checkbox"${val ? ' checked' : ''}> ${f.label}</label></div>
      <div class="help"></div>`;
    const box = wrap.querySelector('input');
    box.addEventListener('change', () => {
      set(app.cfg, f.path, box.checked);
      // A checkbox here changes which OTHER fields mean anything, so the whole
      // panel has to re-read the config rather than just this row.
      rebuild(true);
      syncFields();
      refreshFieldVisibility();
      if (typeof syncOptConstraints === 'function') { syncOptConstraints(); refreshOptDimStates(); }
    });
  } else {
    const disp = (v) => `${(v * f.scale).toFixed(f.digits)}${f.unit ? ' ' + f.unit : ''}`;
    wrap.innerHTML = `<div class="row"><label>${f.label}</label><span class="val">${disp(val)}</span></div>
      <input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
      <div class="help"></div>`;
    const inp = wrap.querySelector('input');
    const out = wrap.querySelector('.val');
    let pending = null;
    inp.addEventListener('input', () => {
      const v = +inp.value;
      out.textContent = disp(v);
      set(app.cfg, f.path, v);
      clearTimeout(pending);
      pending = setTimeout(() => {
        rebuild(false);
        // This field may be an input to a derived one (magnet size -> pitch),
        // so every OTHER row has to be re-read. Skipping the row under the
        // cursor keeps a drag from fighting its own slider.
        syncFields(f.path);
        updateHelp();
      }, 40);
    });
  }
  return wrap;
}

/** Push the config back into the sidebar. Needed because some fields are
 *  derived from others -- pole pitch from magnet size, thickness from cube edge
 *  -- and a slider showing a stale number is a slider that lies about the
 *  machine being simulated. */
function syncFields(exceptPath = null) {
  for (const el of document.querySelectorAll('.field')) {
    const path = el.dataset.path;
    if (!path || path === exceptPath) continue;
    const f = PARAMS.flatMap((g) => g.fields).find((x) => x.path === path);
    if (!f) continue;
    const v = get(app.cfg, path);
    if (f.type === 'check') {
      el.querySelector('input').checked = !!v;
    } else if (f.type === 'select') {
      el.querySelector('select').value = v;
    } else {
      el.querySelector('input').value = v;
      el.querySelector('.val').textContent =
        `${(v * f.scale).toFixed(f.digits)}${f.unit ? ' ' + f.unit : ''}`;
    }
  }
}

function refreshFieldVisibility() {
  document.querySelectorAll('.field').forEach((el) => {
    const f = PARAMS.flatMap((g) => g.fields).find((x) => x.path === el.dataset.path);
    if (!f) return;
    el.style.display = f.show && !f.show(app.cfg) ? 'none' : '';
    // A derived field is shown, not hidden: you still want to read the pole
    // pitch your magnets produced. It just stops being something you can drag.
    el.classList.toggle('derived', !!(f.disabled && f.disabled(app.cfg)));
  });
  updateHelp();
}

function updateHelp() {
  document.querySelectorAll('.field').forEach((el) => {
    const f = PARAMS.flatMap((g) => g.fields).find((x) => x.path === el.dataset.path);
    const h = el.querySelector('.help');
    if (!f || !h) return;
    h.textContent = f.help ? f.help(app.cfg) : '';
    h.style.display = h.textContent ? '' : 'none';
  });
}

// ---------------------------------------------------------------- tiles ----

function tile(k, v, u, cls = '') {
  return `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}<span class="u">${u}</span></div></div>`;
}

const sig = (v, d = 3) => (isFinite(v) ? Number(v.toPrecision(d)).toLocaleString() : '—');

function renderTiles() {
  const a = app.analysis;
  const tr = app.tr;
  const marginCls = a.liftMargin < 1 ? 'crit' : a.liftMargin < 1.6 ? 'warn' : 'good';
  const dT = stackTemperatureRise(a.hoverPower, app.stack);
  const powCls = dT > 60 ? 'crit' : dT > 30 ? 'warn' : '';

  document.getElementById('tiles').innerHTML = [
    tile('Lift margin', sig(a.liftMargin, 3), '× weight', marginCls),
    tile('Platen mass', sig(tr.mass * 1000, 3), 'g'),
    (() => {
      const g = app.cfg.sim.gap, f = app.stack.gapFloor;
      const cls = g < f ? 'crit' : g < f * 1.5 ? 'warn' : 'good';
      return tile('Air gap vs floor', sig(g * 1000, 3), `min ${sig(f * 1000, 3)} mm`, cls);
    })(),
    tile('Peak lateral accel', sig(a.maxAccel / 9.80665, 3), 'g'),
    tile('Hover power', a.hoverSaturated > 1e-6 ? '—' : sig(a.hoverPower, 3), 'W', powCls),
    tile('Stator ΔT (est.)', a.hoverSaturated > 1e-6 ? '—' : sig(dT, 2), 'K', powCls),
    tile('Peak gap field', sig(tr.peakGapField, 3), 'T'),
    (() => {
      // Current density is the gate that decides whether a design needs
      // cooling. Because turns x wire-area is fixed by the winding window,
      // lift capability depends only on J -- this is the thermal price of the
      // force, not a footnote.
      const J = (a.hoverPeakCurrent ?? 0) / (app.stator.wireArea * 1e6);
      const cls = J > 20 ? 'crit' : J > 10 ? 'warn' : 'good';
      return tile('Hover current density', sig(J, 2), 'A/mm²', cls);
    })(),
    tile('Condition number', sig(a.conditionNumber, 3), '', a.conditionNumber > 50 ? 'warn' : ''),
    (() => {
      // Amplifiers is the number that decides whether you can build it. Under
      // a grouping it decouples from the coil count entirely.
      const amp = a.amplifiers;
      const cls = amp > 64 ? 'crit' : amp > 16 ? 'warn' : 'good';
      return tile('Amplifiers', amp, `${a.activeCoils} live coils`, cls);
    })(),
  ].join('');
}

function renderSimTiles(peakI, power) {
  const s = app.state;
  const a = app.analysis;
  const err = Math.hypot(
    s.r[0] - (app.lastTarget?.r[0] ?? 0),
    s.r[1] - (app.lastTarget?.r[1] ?? 0),
    s.r[2] - (app.lastTarget?.r[2] ?? app.cfg.sim.gap));
  const satCls = peakI > app.cfg.sim.iMax * 0.98 ? 'crit' : peakI > app.cfg.sim.iMax * 0.8 ? 'warn' : '';
  document.getElementById('simTiles').innerHTML = [
    tile('Air gap', sig(s.r[2] * 1000, 3), 'mm', s.landed ? 'crit' : ''),
    tile('Track error', sig(err * 1e6, 3), 'µm'),
    tile('Speed', sig(Math.hypot(s.v[0], s.v[1], s.v[2]) * 1000, 3), 'mm/s'),
    tile('Peak current', sig(peakI, 3), `/ ${app.cfg.sim.iMax} A`, satCls),
    tile('Copper loss', sig(power, 3), 'W'),
    tile('Lift margin', sig(a.liftMargin, 3), '×'),
  ].join('');
}

// ---------------------------------------------------------------- charts ---

/** Register a canvas with a draw function; hover triggers a redraw with the
 *  pointer position so tooltips work without any retained scene graph. */
function mountChart(id, draw) {
  const cv = document.getElementById(id);
  const entry = { cv, draw, hover: null };
  app.charts.set(id, entry);
  trackHover(cv, (pos) => { entry.hover = pos; entry.draw(entry.hover); });
  return entry;
}

function redraw(id) {
  const e = app.charts.get(id);
  if (e && e.cv.offsetParent !== null) e.draw(e.hover);
}

function redrawAll() {
  renderTiles();
  renderStackCards();
  renderBuild();
  renderDesignTable();
  for (const id of app.charts.keys()) redraw(id);
  renderSelfTest();
}

const pal = () => theme();

function setupDesignCharts() {
  mountChart('designView', () => {
    render(document.getElementById('designView'), {
      cam: app.camDesign, stator: app.stator, tr: app.tr,
      state: { r: [0, 0, app.cfg.sim.gap], q: quat.identity() },
      currents: app.analysis.hoverCurrents, idxMap: app.analysis.Wm.idx,
      section: app.view.section, zScale: app.view.zScale,
    });
  });
  attachOrbit(document.getElementById('designView'), app.camDesign, () => redraw('designView'));

  mountChart('fieldMap', (h) => {
    const comp = document.getElementById('fieldComponent').value;
    const half = app.cfg.translator.platenSize * 0.6;
    const m = fieldMap(app.tr, app.cfg.sim.gap, half, 96, comp);
    heatmap(document.getElementById('fieldMap'), {
      ...m, hover: h, mode: comp === 'bz' ? 'diverging' : 'sequential',
      xLabel: 'x (m)', yLabel: 'y (m)', units: 'T',
      overlays: app.tr.patches.map((p) => ({
        type: 'rect', x0: p.u - p.w / 2, x1: p.u + p.w / 2,
        y0: p.v - p.h / 2, y1: p.v + p.h / 2, color: pal().ink, dashed: true,
      })),
    });
  });
  document.getElementById('fieldComponent').addEventListener('change', () => redraw('fieldMap'));

  mountChart('gapChart', (h) => {
    const gaps = [];
    const gMax = Math.max(app.cfg.sim.gap * 4, app.cfg.translator.pitch * 0.6);
    for (let i = 0; i < 34; i++) gaps.push(0.0003 + (gMax * i) / 33);
    const r = liftVsGap(app.stator, app.tr, app.cfg.sim.iMax, gaps);
    app._gapPower = r.power;
    lineChart(document.getElementById('gapChart'), {
      hover: h, xLabel: 'air gap (mm)', yLabel: 'lift ÷ weight', yZero: true,
      series: [
        { label: 'lift margin', color: pal().s1, pts: r.margin },
        { label: 'unity (hover threshold)', color: pal().critical, dashed: true,
          pts: r.margin.map((p) => [p[0], 1]) },
        { label: 'peak Bz × 10 (T)', color: pal().s3, pts: r.field.map((p) => [p[0], p[1] * 10]) },
      ],
    });
  });

  mountChart('gapPower', (h) => {
    if (!app._gapPower) redraw('gapChart');
    lineChart(document.getElementById('gapPower'), {
      hover: h, xLabel: 'air gap (mm)', yLabel: 'copper loss (W)', yZero: true,
      series: [{ label: 'hover power', color: pal().s2, pts: app._gapPower || [] }],
      title: 'Power to simply stay up',
    });
  });

  mountChart('capMap', (h) => {
    const metric = document.getElementById('mapMetric').value;
    const half = Math.min(app.cfg.stator.statorSize, app.cfg.translator.pitch * 2.5) / 2;
    const m = capabilityMap(app.stator, app.tr, app.cfg.sim.gap, half, 34, app.cfg.sim.iMax, metric);
    const units = { lift: '×w', sigmaMin: 'N/A', power: 'W', cond: '' }[metric];
    heatmap(document.getElementById('capMap'), {
      ...m, hover: h, mode: 'sequential', xLabel: 'platen x (m)', yLabel: 'platen y (m)', units,
    });
  });
  document.getElementById('mapMetric').addEventListener('change', () => redraw('capMap'));

  mountChart('rippleChart', (h) => {
    const span = app.cfg.translator.pitch * 2;
    const r = rippleScan(app.stator, app.tr, app.cfg.sim.gap, span, 60, app.cfg.sim.iMax);
    lineChart(document.getElementById('rippleChart'), {
      hover: h, xLabel: 'platen x (mm)', yZero: true, yLabel: 'A  /  W',
      series: [
        { label: 'peak coil current (A)', color: pal().s1, pts: r.peakI },
        { label: 'copper loss (W)', color: pal().s2, pts: r.power },
      ],
    });
  });

  mountChart('pitchChart', (h) => {
    const cv = document.getElementById('pitchChart');
    if (!app.pitchRows) {
      const { ctx, w } = (() => {
        const c = cv.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: c, w: cv.clientWidth };
      })();
      ctx.fillStyle = pal().surface;
      ctx.fillRect(0, 0, w, cv.clientHeight);
      ctx.fillStyle = pal().muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Press "Run sweep" — this rebuilds the machine ~20 times.', w / 2, cv.clientHeight / 2);
      return;
    }
    lineChart(cv, {
      hover: h, xLabel: 'pole pitch λ (mm)', yLabel: 'lift ÷ weight   ·   g', yZero: true,
      series: [
        { label: 'lift margin (× weight)', color: pal().s1, pts: app.pitchRows.map((r) => [r.pitch, r.margin]) },
        { label: 'lateral accel (g)', color: pal().s2, pts: app.pitchRows.map((r) => [r.pitch, r.accel]) },
        { label: 'unity', color: pal().critical, dashed: true, pts: app.pitchRows.map((r) => [r.pitch, 1]) },
      ],
    });
  });

  document.getElementById('btnPitchSweep').addEventListener('click', () => {
    const lo = 0.010, hi = 0.070;
    const pitches = [];
    for (let i = 0; i < 20; i++) pitches.push(lo + ((hi - lo) * i) / 19);
    app.pitchRows = pitchSweep(app.cfg, pitches, app.cfg.sim.iMax);
    redraw('pitchChart');
    renderDesignTable();
    document.getElementById('btnPitchApply').disabled = !bestPitchRow();
  });

  // Push the sweep's winner back into the config. "Best" here means the highest
  // lateral acceleration among pitches that can actually hover with margin --
  // ranking on lift margin alone just picks the heaviest-lifting brick.
  document.getElementById('btnPitchApply').addEventListener('click', () => {
    const best = bestPitchRow();
    if (!best) return;
    app.cfg.translator.pitch = best.pitch / 1000;
    if (!app.cfg.stator.lockCoilPitch) app.cfg.stator.coilPitch = best.pitch / 1000 / 3;
    app.camDesign.userZoomed = app.camSim.userZoomed = false;
    rebuild(true);
    buildParamUI();
  });
}

/** Highest lateral accel among pitches that clear a 1.5x lift margin. */
function bestPitchRow() {
  if (!app.pitchRows) return null;
  const ok = app.pitchRows.filter((r) => r.margin >= 1.5 && isFinite(r.accel));
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.accel > a.accel ? b : a));
}

/** The physical stack, and what the air gap is actually made of. */
function renderStackCards() {
  const st = app.stack, c = app.cfg;
  const mmv = (v) => (v * 1000).toFixed(2);
  let h = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Mechanical stack-up</h4>`;
  h += '<div class="table-wrap"><table><thead><tr><th>Layer</th><th>Thickness</th><th style="text-align:left">Material</th><th>Mass</th></tr></thead><tbody>';
  for (const L of st.layers) {
    const cls = L.side === 'gap' ? ' style="color:var(--accent);font-weight:600"' : '';
    h += `<tr${cls}><td>${L.name}</td><td>${mmv(L.t)} mm</td><td style="text-align:left;color:var(--muted)">${L.material}</td><td>${L.mass ? sig(L.mass * 1000, 3) + ' g' : '—'}</td></tr>`;
  }
  h += `</tbody></table></div>
    <p style="font-size:12px;color:var(--ink-2);margin:10px 0 0">
    Platen <b>${sig(st.platenMass * 1000, 3)} g</b> = ${sig(st.magnetMass * 1000, 3)} g magnets +
    ${sig(st.pocketMass * 1000, 3)} g retainer + ${sig(st.backingMass * 1000, 3)} g backing.
    The retainer wall displaces <b>${(st.wallFraction * 100).toFixed(0)}%</b> of the magnet layer — that is field you do not get.</p>
    <p style="font-size:12px;color:var(--muted);margin:6px 0 0">
    Assembly: adjacent Halbach magnets push about <b>${sig(st.neighbourForce, 2)} N</b> apart
    (order-of-magnitude bound from B²/2µ₀), loading the retainer wall to
    <b>${sig(st.wallStress / 1e6, 2)} MPa</b>. Thermal path ${st.thermalResistance.toFixed(2)} K/W via ${st.coolingLabel.toLowerCase()}.</p>`;
  document.getElementById('stackCard').innerHTML = h;

  const floor = st.gapFloor, gap = c.sim.gap;
  const ok = gap >= floor;
  let g = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Air-gap budget</h4>`;
  g += '<div class="table-wrap"><table><thead><tr><th>Contribution</th><th>mm</th><th style="text-align:left">Source</th></tr></thead><tbody>';
  const worst = st.terms.reduce((a, b) => (b.v > a.v ? b : a));
  for (const t of st.terms) {
    g += `<tr${t === worst ? ' style="font-weight:600"' : ''}><td>${t.label}${t === worst ? ' ←' : ''}</td><td>${(t.v * 1000).toFixed(3)}</td><td style="text-align:left;color:var(--muted)">${t.note}</td></tr>`;
  }
  g += `<tr style="border-top:2px solid var(--axis)"><td><b>Minimum air gap</b></td><td><b>${(floor * 1000).toFixed(3)}</b></td><td style="text-align:left;color:var(--muted)">sum</td></tr>`;
  g += `<tr><td>Design uses</td><td style="color:${ok ? 'var(--good)' : 'var(--crit)'};font-weight:600">${(gap * 1000).toFixed(3)}</td><td style="text-align:left;color:${ok ? 'var(--good)' : 'var(--crit)'}">${ok ? `OK — ${(gap / floor).toFixed(1)}× the floor` : 'TOO TIGHT — it will touch down'}</td></tr>`;
  g += '</tbody></table></div>';
  g += `<p style="font-size:12px;color:var(--muted);margin:10px 0 0">Largest term is <b>${worst.label.toLowerCase()}</b>. Attack that one first — the others are rounding error until it moves.</p>`;
  document.getElementById('gapCard').innerHTML = g;
}

// ----------------------------------------------------------------- build ---

function setupBuildCharts() {
  mountChart('explodedView', () => {
    renderExploded(document.getElementById('explodedView'), {
      cam: app.camExp, assembly: app.assembly, tr: app.tr, stator: app.stator,
      explode: app.viewExp.explode, zScale: app.viewExp.zScale,
    });
  });
  attachOrbit(document.getElementById('explodedView'), app.camExp, () => redraw('explodedView'));
}

/** Bill of materials, magnet order list, and an explicit list of what the
 *  drawing does not know. */
function renderBuild() {
  const A = app.assembly, st = app.stack;
  const g = (kg) => `${sig(kg * 1000, 3)} g`;

  let h = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Bill of materials</h4>`;
  h += '<div class="table-wrap"><table><thead><tr><th>#</th><th style="text-align:left">Part</th><th>Qty</th><th style="text-align:left">Specification</th><th style="text-align:left">Material / process</th><th>Mass</th></tr></thead><tbody>';
  A.parts.forEach((p, i) => {
    const isGap = p.kind === 'gap';
    const style = isGap ? ' style="color:var(--accent);font-weight:600"' : '';
    h += `<tr${style}><td>${i + 1}</td><td style="text-align:left">${p.name}</td>
      <td>${isGap ? '—' : p.qty}</td>
      <td style="text-align:left;color:var(--ink-2)">${p.spec}</td>
      <td style="text-align:left;color:var(--muted)">${p.material}${p.process !== '—' ? ` · ${p.process}` : ''}</td>
      <td>${p.mass ? g(p.mass) : '—'}</td></tr>`;
    h += `<tr><td></td><td colspan="5" style="text-align:left;color:var(--muted);font-size:11px;padding-top:0">${p.note}
      ${p.critical ? `<br><span style="color:var(--warn)">Watch: ${p.critical}</span>` : ''}</td></tr>`;
  });
  for (const c of A.consumables) {
    h += `<tr><td>—</td><td style="text-align:left">${c.name}</td><td>${c.qty}</td>
      <td style="text-align:left;color:var(--ink-2)">${c.spec}</td>
      <td style="text-align:left;color:var(--muted)">${c.material}</td><td>${g(c.mass)}</td></tr>`;
  }
  h += '</tbody></table></div>';
  h += `<p style="font-size:12px;color:var(--ink-2);margin:10px 0 0">
    Moving mass <b>${g(A.movingMass)}</b> (everything above the gap — this is what the motor lifts).
    Fixed mass ${g(A.fixedMass)}. Stator stands ${(A.statorHeight * 1000).toFixed(1)} mm tall,
    platen ${(A.platenHeight * 1000).toFixed(1)} mm.</p>`;
  document.getElementById('bomCard').innerHTML = h;

  // --- PCB stator export ---------------------------------------------------
  // The coil board is the one part in this BOM that is a file, not a shape to
  // machine -- so hand over the file. Only meaningful for PCB coils; a wound
  // stator has no copper to fabricate.
  const pcbCard = document.getElementById('pcbExportCard');
  if (app.cfg.stator.coilType === 'pcb') {
    const kc = buildKiCad(app.stator, app.cfg);
    const s = kc.stats;
    const big = s.segments > 200000;
    pcbCard.style.display = '';
    pcbCard.innerHTML = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">PCB stator export</h4>
      <p style="font-size:12px;color:var(--ink-2);margin:0 0 10px">The coil board as a <b>.kicad_pcb</b> you can open in KiCad and send to a fab —
      ${s.coils} coils on ${s.layers} copper layers, ${s.turnsPerLayer} turns each per layer, series-stacked so every layer's field adds.
      ${s.segments.toLocaleString()} track segments, ${s.vias.toLocaleString()} buried vias, one net per coil, ${s.traceMm.toFixed(3)} mm trace on a ${s.boardMm.toFixed(0)} mm board.</p>
      <button id="btnKicad" class="ghost">Download KiCad PCB</button>
      ${big ? '<p style="font-size:12px;color:var(--warn);margin:8px 0 0">This is a large board — the file runs to a few MB and KiCad will take a moment to open it.</p>' : ''}
      <p style="font-size:12px;color:var(--muted);margin:8px 0 0">Buried vias between adjacent layers make this a real (and, past 12 layers, expensive) stackup — the export writes the board the physics ran, not a simplified one.</p>`;
    document.getElementById('btnKicad').onclick = () => {
      const fresh = buildKiCad(app.stator, app.cfg);
      const blob = new Blob([fresh.text], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `maglev-stator-${app.presetKey ?? 'design'}-${s.layers}L.kicad_pcb`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  } else {
    pcbCard.style.display = 'none';
    pcbCard.innerHTML = '';
  }

  // --- magnet order list ---------------------------------------------------
  const c = A.census, grade = A.grade;
  let m = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Magnet order</h4>`;
  m += `<p style="font-size:12px;color:var(--ink-2);margin:0 0 10px">
    <b>${c.total}</b> blocks at ${(c.cellW * 1000).toFixed(2)} × ${(c.cellH * 1000).toFixed(2)} ×
    ${(app.cfg.translator.magnetThickness * 1000).toFixed(2)} mm, ${grade.name}
    (Br ${app.cfg.translator.Br.toFixed(2)} T${grade.exact ? '' : ` — nearest catalogue grade is ${grade.name} at ${grade.Br} T`})${
      c.empty ? `, filling ${c.total} of the platen's ${c.cells} pockets — the other ${c.empty} are nulls in the pattern and stay empty` : ''}.</p>`;
  const orderAs = { axial: 'through-thickness (stock)', 'in-plane': 'through-length (stock)',
    diagonal: 'diagonal — CUSTOM', empty: 'nothing — leave the pocket empty' };
  m += '<div class="table-wrap"><table><thead><tr><th style="text-align:left">Magnetisation on the platen</th><th>Count</th><th style="text-align:left">Order as</th></tr></thead><tbody>';
  for (const r of c.rows) {
    const bad = r.cls === 'diagonal';
    m += `<tr><td style="text-align:left">${r.label}</td><td>${r.n}</td>
      <td style="text-align:left;color:${bad ? 'var(--crit)' : 'var(--muted)'}">${orderAs[r.cls]}</td></tr>`;
  }
  m += `</tbody></table></div>
    <p style="font-size:12px;color:var(--muted);margin:10px 0 0">
    ${c.rows.filter((r) => r.cls !== 'empty').length} orientations, <b>${c.skus.length} part number${c.skus.length === 1 ? '' : 's'}</b>
    (${c.skus.join(', ')}). Direction on the platen is an assembly step, not a different part —
    which is exactly why the cells are square.</p>`;

  if (A.orderPlan) {
    const o = A.orderPlan;
    m += `<div style="margin-top:10px;padding:10px;border-left:3px solid var(--good);background:var(--plane)">
      <p style="font-size:12px;color:var(--good);margin:0 0 8px"><b>Order list — ${o.vendor}.</b>
      ${o.skus} catalogue part${o.skus === 1 ? '' : 's'}, verified ${o.verified}. ${o.note}</p>
      <div class="table-wrap"><table><thead><tr><th style="text-align:left">Order as</th><th>For</th><th>Qty</th><th>Unit</th><th>Line</th></tr></thead><tbody>`;
    for (const l of o.lines) {
      m += `<tr><td style="text-align:left"><a href="${l.url}" target="_blank" rel="noopener" style="color:var(--accent)">${l.order}</a></td>
        <td style="color:var(--muted)">${l.for === 'both' ? 'all blocks' : l.for}</td>
        <td>${l.qty}</td><td>$${l.unit.toFixed(2)}</td><td>$${l.cost.toFixed(2)}</td></tr>`;
    }
    m += `</tbody></table></div>
      <p style="font-size:12px;color:var(--ink-2);margin:8px 0 0"><b>$${o.total.toFixed(2)}</b> of magnet for the whole platen at list price, before quantity breaks. Order spares — these chip, and you assemble against ${sig(st.neighbourForce, 2)} N of neighbour repulsion.</p></div>`;
  }

  if (A.sourcing) {
    m += `<div style="margin-top:10px;padding:10px;border-left:3px solid var(--crit);background:var(--plane)">
      <p style="font-size:12px;color:var(--crit);margin:0 0 6px"><b>Sourcing problem.</b> ${A.sourcing.problem}
      Diagonally-magnetised blocks are a custom order — several times the price of stock, with lead time to match.</p>
      <p style="font-size:12px;color:var(--ink-2);margin:0 0 6px"><b>Cause.</b> ${A.sourcing.cause}</p>
      <p style="font-size:12px;color:var(--ink-2);margin:0"><b>Fix.</b> ${A.sourcing.remedy}
      Result: ${A.sourcing.after}</p></div>`;
  }

  m += `<p style="font-size:12px;color:var(--warn);margin:8px 0 0">
    Assembly load: neighbours push about ${sig(st.neighbourForce, 2)} N apart, and ${c.total} of them go in
    one at a time. A jig is not optional at this cell size.</p>`;
  document.getElementById('magnetOrderCard').innerHTML = m;

  // --- what this drawing does not know -------------------------------------
  let n = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Not in this drawing</h4>
    <p style="font-size:12px;color:var(--ink-2);margin:0 0 8px">Every dimension above is derived from the
    config the physics runs on. These are the parts of a real build that nothing in the model determines,
    so they are absent rather than invented:</p><ul style="font-size:12px;color:var(--muted);margin:0;padding-left:18px">`;
  for (const item of A.notModelled) n += `<li style="margin-bottom:4px">${item}</li>`;
  n += '</ul>';
  document.getElementById('notModelledCard').innerHTML = n;
}

function renderDesignTable() {
  const el = document.getElementById('designTable');
  const c = app.cfg, tr = app.tr, st = app.stator, a = app.analysis;
  // Same counter the drawing and the BOM use, so the three cannot disagree.
  const nMag = app.assembly.census.total;
  const wireLen = st.coils.reduce((L, k) => L + k.turns * 2 * (k.outer[0] + k.outer[1]), 0);
  const rows = [
    ['Magnets on the platen', `${nMag}`, `${(tr.tile.lx / tr.tile.nx * 1000).toFixed(1)} × ${(tr.tile.ly / tr.tile.ny * 1000).toFixed(1)} × ${(c.translator.magnetThickness * 1000).toFixed(1)} mm each`
      + (app.assembly.census.empty ? `, in ${app.assembly.census.cells} pockets — ${app.assembly.census.empty} stay empty` : '')],
    ['Magnet mass', `${sig(app.stack.magnetMass * 1000, 3)} g`,
      `NdFeB at 7500 kg/m³, less the ${(app.stack.wallFraction * 100).toFixed(0)}% displaced by retainer wall`
      + (app.stack.magnetFill < 0.999 ? ` and the ${(100 - app.stack.magnetFill * 100).toFixed(0)}% of cells the pattern leaves empty` : '')],
    ...(() => {
      // The array is symmetric by construction, but the platen size decides WHICH
      // symmetric array and how much border is thrown away. A platen that exactly
      // fits an even number of cells is the worst case: it gives up a cell on each
      // side to reach the next odd count down. That is worth a line, because it is
      // a fifth of the magnet count and the fix is to change one number.
      // Per PATCH, not per platen: the quad layout's arms are each 0.42 of the
      // platen, so a platen-wide answer would describe an array nobody built.
      const pt = tr.patches[0];
      const sym = arraySymmetry(tr.tile, pt);
      if (!sym) return [];
      const many = tr.patches.length > 1;
      const waste = Math.max(sym.waste[0], sym.waste[1]) * 1000;
      return [['Array symmetry', `${sym.nx} × ${sym.ny}, rim of ${sym.rim}`,
        `${(sym.across[0] * 1000).toFixed(1)} × ${(sym.across[1] * 1000).toFixed(1)} mm`
        + (many ? ` per arm, ${tr.patches.length} arms of ` : ' on a ')
        + `${(pt.w * 1000).toFixed(1)} × ${(pt.h * 1000).toFixed(1)} mm`
        + (waste > 0.05
          ? ` — up to ${waste.toFixed(1)} mm of border unused; ${(sym.next[0] * 1000).toFixed(1)} × ${(sym.next[1] * 1000).toFixed(1)} mm would carry ${sym.nextCells[0]} × ${sym.nextCells[1]}.`
          : ' — no border wasted.')]];
    })(),
    ['Coils in stator', `${st.coils.length}`, `${st.effTurns} effective turns each, ${sig(st.coils[0]?.R ?? 0, 3)} Ω`],
    ['Total wire length', `${sig(wireLen, 3)} m`, `${sig(st.copperMass * 1000, 3)} g of copper`],
    ['Driver channels needed', `${a.amplifiers}`,
      a.amplifiers < st.coils.length
        ? `${st.coils.length} coils commutated in groups (${c.sim.grouping})`
        : 'one H-bridge per coil, or a switching matrix'],
    ['Retained field harmonics', `${tr.harm.n}`, `order ≤ ${QUALITY[c.sim.quality].maxOrder}`],
    ...(st.truncated ? [['Stator truncated', 'yes',
      'coil count hit the 48×48 cap — the modelled stator is smaller than the size you set']] : []),
    ['Wrench singular values σ', a.sigma.map((s) => sig(s, 2)).join('  '), 'torque rows normalised by half-platen; last value is σmin'],
  ];
  let html = '<div class="table-wrap"><table><thead><tr><th>Build quantity</th><th>Value</th><th style="text-align:left">Note</th></tr></thead><tbody>';
  for (const [k, v, n] of rows) html += `<tr><td>${k}</td><td>${v}</td><td style="text-align:left;color:var(--muted)">${n}</td></tr>`;
  html += '</tbody></table></div>';

  if (app.pitchRows) {
    html += '<h3 style="font-size:12px;margin:16px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Pole-pitch sweep results</h3><div class="table-wrap"><table><thead><tr><th>λ (mm)</th><th>lift ÷ w</th><th>accel (g)</th><th>hover P (W)</th><th>σmin</th><th>cond</th><th>mass (g)</th><th>peak B (T)</th></tr></thead><tbody>';
    const bp = bestPitchRow();
    for (const r of app.pitchRows) {
      html += `<tr${r === bp ? ' style="font-weight:600"' : ''}><td>${r.pitch.toFixed(1)}${r === bp ? ' ★' : ''}</td><td>${sig(r.margin, 3)}</td><td>${sig(r.accel, 3)}</td><td>${sig(r.power, 3)}</td><td>${sig(r.sigmaMin, 3)}</td><td>${sig(r.cond, 3)}</td><td>${sig(r.mass * 1000, 3)}</td><td>${sig(r.peakB, 3)}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

function renderSelfTest() {
  const t = selfTest();
  document.getElementById('selfTest').innerHTML =
    `<strong>Model check.</strong> Fundamental of a 4-segment 1-D Halbach:<br>
     model ${t.model.toFixed(4)} T vs closed form ${t.analytic.toFixed(4)} T
     (${(t.relError * 100).toFixed(2)}% <span class="${t.pass ? 'ok' : 'bad'}">${t.pass ? 'PASS' : 'FAIL'}</span>)`;
}

// ------------------------------------------------------------ simulation ---

function setupSimCharts() {
  mountChart('simView', () => {
    render(document.getElementById('simView'), {
      cam: app.camSim, stator: app.stator, tr: app.tr, state: app.state,
      currents: app.lastCurrents, idxMap: app.lastIdx,
      target: app.lastTarget?.r, trail: app.hist.trail,
      section: app.viewSim.section, zScale: app.viewSim.zScale,
    });
  });
  attachOrbit(document.getElementById('simView'), app.camSim, () => redraw('simView'));

  mountChart('currentStrip', (h) => {
    barStrip(document.getElementById('currentStrip'), app.lastCurrents ?? [], {
      hover: h, labels: (i) => {
        const c = app.stator.coils[app.lastIdx?.[i] ?? 0];
        return c ? `coil at (${(c.x * 1000).toFixed(0)}, ${(c.y * 1000).toFixed(0)}) mm` : `coil ${i}`;
      },
    });
  });

  const scope = (id, keys, labels, colors, yLabel) => mountChart(id, (h) => {
    const H = app.hist;
    lineChart(document.getElementById(id), {
      hover: h, xLabel: 't (s)', yLabel,
      series: keys.map((k, i) => ({
        label: labels[i], color: colors[i], pts: H.t.map((t, j) => [t, H[k][j]]),
      })),
    });
  });
  const p = pal();
  scope('scopePos', ['ex', 'ey', 'ez'], ['x', 'y', 'z'], [p.s1, p.s2, p.s3], 'error (µm)');
  scope('scopeAtt', ['ax', 'ay', 'az'], ['roll', 'pitch', 'yaw'], [p.s1, p.s2, p.s3], 'error (mrad)');
  scope('scopeCur', ['ip'], ['peak |i|'], [p.s1], 'A');
  scope('scopePow', ['pw'], ['copper loss'], [p.s2], 'W');
}

function simulate(frameDt) {
  const q = QUALITY[app.cfg.sim.quality];
  const dt = 1 / q.controlHz;
  const nSteps = clamp(Math.round(frameDt / dt), 1, 60);
  const tp = { ...app.trajParams, gap: app.cfg.sim.gap };
  let peakI = 0, power = 0;

  for (let s = 0; s < nSteps; s++) {
    const target = TRAJECTORIES[app.traj].at(app.state.t, tp);
    app.lastTarget = target;
    const { w, ep, ea } = control(app.ctrl, app.state, app.tr, dt, target);
    const base = buildWrench(app.stator, app.tr, app.state.r, app.state.q);
    const Wm = app.cfg.sim.grouping === 'independent' ? base
      : groupWrench(base, buildGrouping(app.stator, app.tr, app.state.r, app.state.q,
        app.cfg.sim.grouping, base.idx));
    // Levitation first, manoeuvring with whatever headroom is left.
    const wLift = [0, 0, app.tr.mass * 9.80665, 0, 0, 0];
    const alloc = allocatePrioritised(Wm, wLift,
      w.map((v, i) => v - wLift[i]), app.cfg.sim.iMax);
    app.ctrl.sat = alloc.saturated; // feeds the controller's anti-windup
    const wrench = applyDisturbance(app.dist, alloc.achieved, dt, app.tr);
    step(app.state, app.tr, wrench, dt);

    // Display and limits are in COIL space even when driving few amplifiers.
    app.lastCurrents = alloc.coilI ?? alloc.i;
    app.lastPhases = alloc.i;
    app.lastIdx = base.idx;
    peakI = 0;
    for (let j = 0; j < app.lastCurrents.length; j++) {
      peakI = Math.max(peakI, Math.abs(app.lastCurrents[j]));
    }
    power = copperLoss(app.stator, Wm, alloc.i);

    // Sample the scopes at a fixed rate rather than every control step.
    if (s === nSteps - 1) {
      const H = app.hist;
      H.t.push(app.state.t);
      H.ex.push(ep[0] * 1e6); H.ey.push(ep[1] * 1e6); H.ez.push(ep[2] * 1e6);
      H.ax.push(ea[0] * 1e3); H.ay.push(ea[1] * 1e3); H.az.push(ea[2] * 1e3);
      H.ip.push(peakI); H.pw.push(power);
      H.trail.push([app.state.r[0], app.state.r[1], app.state.r[2]]);
      const cap = 420;
      for (const k of ['t', 'ex', 'ey', 'ez', 'ax', 'ay', 'az', 'ip', 'pw']) {
        if (H[k].length > cap) H[k].shift();
      }
      if (H.trail.length > 600) H.trail.shift();
    }

    // Runaway guard: if the loop diverges, stop rather than render NaNs.
    if (!isFinite(app.state.r[0]) || Math.hypot(app.state.r[0], app.state.r[1]) > 5) {
      resetSimulation();
      app.running = false;
      document.getElementById('btnPlay').textContent = 'Play';
      break;
    }
  }
  app.lastPeakI = peakI;
  app.lastPower = power;
}

function frame(ts) {
  const dt = app.lastFrame ? Math.min((ts - app.lastFrame) / 1000, 0.05) : 0.016;
  app.lastFrame = ts;

  if (app.tab === 'simulate') {
    if (app.running) simulate(dt);
    redraw('simView');
    redraw('currentStrip');
    redraw('scopePos'); redraw('scopeAtt'); redraw('scopeCur'); redraw('scopePow');
    renderSimTiles(app.lastPeakI ?? 0, app.lastPower ?? 0);
    const st = document.getElementById('simStatus');
    const sat = (app.lastPeakI ?? 0) >= app.cfg.sim.iMax * 0.995;
    if (app.notice && app.state.t < app.notice.until) {
      st.textContent = app.notice.text;
      st.className = 'status';
      requestAnimationFrame(frame);
      return;
    }
    st.textContent = app.state.landed
      ? 'CRASHED — platen is resting on the stator. Lower the mass, raise the current limit, or shorten the pole pitch.'
      : sat ? 'Current limited — the allocator is scaling the commanded wrench back.'
        : `t = ${app.state.t.toFixed(2)} s · ${QUALITY[app.cfg.sim.quality].controlHz} Hz control`;
    st.className = 'status' + (app.state.landed || sat ? ' crit' : '');
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------- wire ---

function setupChrome() {
  const presetSel = document.getElementById('presetSelect');
  presetSel.innerHTML = Object.entries(PRESETS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  presetSel.value = app.presetKey;
  presetSel.addEventListener('change', () => {
    app.camDesign.userZoomed = app.camSim.userZoomed = false;
    loadPreset(presetSel.value);
    renderAbout();
    syncOptConstraints();
    refreshOptDimStates();
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    app.camDesign.userZoomed = app.camSim.userZoomed = false;
    loadPreset(app.presetKey);
  });

  const showTab = (name) => {
    const b = document.querySelector(`#tabs button[data-tab="${name}"]`);
    if (!b) return;
    app.tab = name;
    app.closeDrawer?.();
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // the tab strip scrolls on a phone
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
    if (name === 'design') redrawAll();
    if (name === 'build') { renderBuild(); redraw('explodedView'); }
    if (name === 'optimise') { redraw('optScatter'); redraw('optSlice'); }
  };
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { history.replaceState(null, '', `#${b.dataset.tab}`); showTab(b.dataset.tab); }
  });
  // A tab is worth linking to, and it makes the view scriptable.
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  app.showTab = showTab;   // the initial hash is applied at boot, once there is a machine to draw

  // --- parameter drawer (narrow screens only) ------------------------------
  // The sidebar is always in the DOM; below 820 px the stylesheet lifts it out
  // of the flow and this toggles it in. Anything that takes the user's
  // attention elsewhere -- a tab, the scrim, Escape -- closes it, because a
  // drawer left open over the chart you just asked for is worse than no drawer.
  {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('scrim');
    const btn = document.getElementById('paramsToggle');
    const setDrawer = (open) => {
      sidebar.classList.toggle('open', open);
      scrim.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    app.closeDrawer = () => setDrawer(false);
    btn.addEventListener('click', () => setDrawer(!sidebar.classList.contains('open')));
    scrim.addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
    // Widening past the breakpoint puts the sidebar back in the flow, so the
    // scrim must not be left covering the page.
    // Must match the media query in style.css that lifts the sidebar out of flow.
    window.matchMedia('(max-width: 820px), (max-height: 500px)')
      .addEventListener('change', () => setDrawer(false));
  }

  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur ? cur === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    setupSimCharts(); // scope colours are baked in at mount time
    redrawAll();
  });

  const trajSel = document.getElementById('trajSelect');
  trajSel.innerHTML = Object.entries(TRAJECTORIES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  trajSel.addEventListener('change', () => { app.traj = trajSel.value; });

  const bind = (id, outId, fmt, apply) => {
    const el = document.getElementById(id), out = document.getElementById(outId);
    const upd = () => { out.textContent = fmt(+el.value); apply(+el.value); };
    el.addEventListener('input', upd); upd();
  };
  bind('trajSpeed', 'trajSpeedOut', (v) => `${v.toFixed(1)}`, (v) => { app.trajParams.speed = v; });
  bind('trajAmp', 'trajAmpOut', (v) => `${v} mm`, (v) => { app.trajParams.amplitude = v / 1000; });
  bind('noiseSlider', 'noiseOut', (v) => `${(v * 100).toFixed(1)}%`, (v) => { app.dist.noise = v; });

  document.getElementById('btnPlay').addEventListener('click', (e) => {
    app.running = !app.running;
    e.target.textContent = app.running ? 'Pause' : 'Play';
  });
  document.getElementById('btnResetSim').addEventListener('click', resetSimulation);
  document.getElementById('btnKick').addEventListener('click', () => kick(app.dist, app.tr, 0.6, 25));

  // The air-gap budget assumes a control error; the sim measures one. Wiring
  // the measurement back into the budget closes the loop -- you cannot fly
  // closer to the stator than you can hold position.
  document.getElementById('btnUseMeasured').addEventListener('click', () => {
    const H = app.hist;
    if (!H || H.ez.length < 30) return;
    // A clearance budget is worst-case, not statistical: what matters is the
    // largest excursion the loop actually allowed, including disturbance
    // recovery. Quiet-hover RMS would flatter the design badly -- kick it and
    // run a trajectory first, then press this.
    const n = H.ez.length, tail = Math.max(0, n - 300);
    let peak = 0, s2 = 0, cnt = 0;
    for (let i = tail; i < n; i++) {
      const e = Math.abs(H.ez[i]) * 1e-6;
      peak = Math.max(peak, e);
      s2 += e * e; cnt++;
    }
    const sigma3 = 3 * Math.sqrt(s2 / Math.max(cnt, 1));
    const measured = Math.max(peak, sigma3);
    const used = clamp(measured, 1e-5, 1e-3);
    app.cfg.mech.controlError = used;
    rebuild(false);
    buildParamUI();
    // The frame loop rewrites simStatus every tick, so latch the message.
    app.notice = {
      text: `measured vertical error: peak ${(peak * 1e6).toFixed(1)} µm, 3σ ${(sigma3 * 1e6).toFixed(1)} µm`
        + `${used !== measured ? ` (clamped to ${(used * 1e6).toFixed(0)} µm)` : ''}`
        + ` → air-gap floor now ${(app.stack.gapFloor * 1000).toFixed(2)} mm`,
      until: app.state.t + 6,
    };
  });

  // Section / vertical-exaggeration controls for both 3-D views.
  const wireView = (v, axisId, fracId, zId, zOutId, canvasId) => {
    const axis = document.getElementById(axisId);
    const frac = fracId && document.getElementById(fracId);
    const z = document.getElementById(zId);
    const zOut = document.getElementById(zOutId);
    const upd = () => {
      v.section.axis = axis.value;
      if (frac) v.section.frac = +frac.value;
      v.zScale = +z.value;
      zOut.textContent = z.value;
      if (frac) frac.disabled = axis.value === 'none';
      redraw(canvasId);
    };
    axis.addEventListener('change', upd);
    frac?.addEventListener('input', upd);
    z.addEventListener('input', upd);
    upd();
  };
  wireView(app.view, 'secAxis', 'secFrac', 'zScale', 'zScaleOut', 'designView');
  wireView(app.viewSim, 'secAxisSim', null, 'zScaleSim', 'zScaleSimOut', 'simView');

  const wireExplode = () => {
    const e = document.getElementById('explodeAmt');
    const eo = document.getElementById('explodeOut');
    const z = document.getElementById('zScaleExp');
    const zo = document.getElementById('zScaleExpOut');
    const upd = () => {
      app.viewExp.explode = +e.value;
      app.viewExp.zScale = +z.value;
      eo.textContent = (+e.value).toFixed(2);
      zo.textContent = z.value;
      redraw('explodedView');
    };
    e.addEventListener('input', upd);
    z.addEventListener('input', upd);
    upd();
  };
  wireExplode();

  window.addEventListener('resize', () => {
    if (app.tab === 'design') redrawAll();
    if (app.tab === 'build') redraw('explodedView');
  });
}

function renderAbout() {
  document.getElementById('aboutBody').innerHTML = `
    <h2>What this simulates</h2>
    <p>A moving-magnet planar motor: a Halbach permanent-magnet platen flying above a
    stationary array of ironless coils. There is no iron anywhere in the model, which is
    what makes a closed-form treatment legitimate — the magnets and the coils interact
    only through free space.</p>

    <h2>The model, in one paragraph</h2>
    <p>The platen magnetisation is expanded as a 2-D Fourier series over one spatial
    period. Each harmonic's air-gap field decays as <code>exp(−k·d)</code>, and the
    one-sided (Halbach) flux condition falls out of the algebra rather than being assumed.
    Force and torque on the platen come from Lorentz integration of <code>I·dl × B</code>
    over every coil filament, negated by Newton's third law. Because that is linear in
    current, the whole machine collapses to a 6×N <em>wrench matrix</em>
    <code>W</code>: commutation is <code>i = W⁺w</code>, force capability is the singular
    values of <code>W</code>, and dead spots are poses where σ<sub>min</sub> collapses.</p>

    <h2>Where the model is approximate</h2>
    <ul>
      <li><strong>Finite array edges</strong> are handled with a half-pitch smooth taper on
      the periodic field, which is the right answer for the wrong reason. Measured against an
      exact finite-array calculation (<code>test/reference-field.mjs</code>), the real field is
      still ~91% of its interior value at the centre of the outermost block and dies over about
      one <em>air gap</em> — not one half-pitch — so as a field model the taper is far too
      aggressive. What it accidentally reproduces is the <em>usable</em> array: the documented
      fix for edge effects is on the coil side, not the magnet side. The field near an edge does
      not lose amplitude so much as lose its sinusoidal shape in the direction normal to that
      edge, which breaks the commutation law, and Jansen's answer is to smoothly switch off the
      coils reaching under the outer magnet row — costing a de-rated band about one magnet row
      deep. A smoothstep's effective edge sits at its midpoint, <code>pitch/4</code>, which at
      four segments per wavelength is exactly one magnet cell. So the number is right and the
      mechanism modelled is not, and nothing here actually de-rates commutation near the rim.</li>
      <li><strong>Array voids are not an edge problem.</strong> One cell in four of the 2-D
      checkerboard is empty because the ideal pattern has a null there, and the perimeter
      therefore ends on a half-empty ring. That is the real array, not a defect: dropping magnets
      into the nulls changes the force-producing fundamental by 0.00% at 33% more magnet, and
      only adds higher harmonics plus a net moment the balanced array does not have. No published
      planar-motor design terminates its perimeter on full or vertical blocks.</li>
      <li><strong>No eddy currents, no iron, no back-EMF-limited drivers.</strong> The
      current source is ideal. Real drivers run out of voltage at speed.</li>
      <li><strong>Commutation weights are sampled at each coil's centre.</strong>
      Fine for compact coils; poor for long racetracks, whose long sides span a
      wide range of magnet phase. Some of the racetrack's poor behaviour under
      grouping is this approximation rather than the topology itself.</li>
      <li><strong>Thermal estimate is crude</strong> — a fixed natural-convection
      coefficient over the stator footprint. It exists to flag designs that will obviously
      melt, not to size a heatsink.</li>
      <li><strong>Magnet μ<sub>r</sub> = 1.</strong> Real NdFeB is ≈1.05.</li>
      <li>The <strong>model check</strong> in the sidebar compares the computed fundamental
      against the textbook closed form for a discrete Halbach array. If it says FAIL, don't
      trust anything else on screen.</li>
    </ul>

    <h2>Phase grouping</h2>
    <p>Real machines do not give every coil its own amplifier. Coils are wired or
    switched into a few groups and commutated against the magnet phase. Since
    <code>i = G·u</code>, the wrench matrix just composes to <code>W·G</code> and
    everything downstream still works — so the <strong>Drive</strong> selector
    lets you ask "how few amplifiers can this design get away with?".</p>
    <p>On the four-array cross, <strong>8 amplifiers track exactly as well as
    121</strong>, at roughly double the hover power — that is the published
    eight-phase scheme. On the racetrack it fails outright. Watch the condition
    number and the capability map as you coarsen the grouping: too few groups and
    the wrench matrix loses rank, and the platen becomes uncontrollable in tilt
    or yaw no matter how much current you have.</p>

    <h2>The Optimise tab</h2>
    <p>Pole pitch, air gap, winding height and coil pitch are <em>coupled</em> —
    the best value of each depends on the others — so sweeping one at a time
    answers the wrong question. The search samples the whole space, then refines
    around the best candidates.</p>
    <p>Designs are <strong>constrained, then ranked</strong>, never scored by a
    weighted sum: no amount of low hover power makes up for a machine that cannot
    lift itself somewhere in its workspace. If nothing is feasible you get a
    ranked histogram of what blocked it; if the winner sits on a search bound you
    get told, because then the bound chose the answer, not the physics.</p>
    <p>Applying a design re-verifies it at full solver quality — the search runs
    deliberately coarse for speed. And note the obvious hazard: an optimiser is
    very good at finding whichever corner of a model is least faithful, so treat
    what comes out as a hypothesis to check rather than an answer.</p>

    <h2>Reading the design tab</h2>
    <ul>
      <li><strong>Lift margin</strong> below 1 means it physically cannot hover. Aim for 2–3×
      so there is authority left for acceleration and disturbance rejection.</li>
      <li><strong>Lift vs air gap</strong> is the plot that kills most first designs. Flying
      height is set by pole pitch, full stop.</li>
      <li><strong>Capability map</strong> shows whether the machine is uniform across the
      stator. Periodic dark patches mean the commutation loses a degree of freedom at
      certain positions — usually a coil-pitch / pole-pitch ratio problem.</li>
      <li><strong>Condition number</strong> above ~50 means some wrench direction is much
      more expensive than others; the controller will feel sloppy in that axis.</li>
    </ul>

    <h2>Current preset</h2>
    <p>${PRESETS[app.presetKey].blurb}</p>

    <h2>Source literature</h2>
    <ul>
      <li>W.-J. Kim, <em>High-Precision Planar Magnetic Levitation</em>, PhD thesis, MIT, 1997 —
      <a href="https://dspace.mit.edu/handle/1721.1/10419" target="_blank" rel="noopener">dspace.mit.edu</a>.
      The origin of the field; four Halbach linear levitation motors under one platen.</li>
      <li>J. W. Jansen, <em>Magnetically Levitated Planar Actuator with Moving Magnets</em>,
      PhD thesis, TU Eindhoven, 2007 —
      <a href="https://pure.tue.nl/ws/files/2471953/200711951.pdf" target="_blank" rel="noopener">pure.tue.nl (PDF)</a>.
      The harmonic force/torque model this simulator implements, plus commutation.</li>
      <li>H. Zhu, T. J. Teo, C. K. Pang, <em>Design and Modeling of a Six-Degree-of-Freedom
      Magnetically Levitated Positioner Using Square Coils and 1-D Halbach Arrays</em>,
      IEEE Trans. Industrial Electronics 64(1):440&ndash;450, 2017 —
      <a href="https://danielteodesigntechnology.wordpress.com/wp-content/uploads/2011/06/maglev_square_coils_tie2016.pdf" target="_blank" rel="noopener">PDF</a>.
      The most buildable topology.</li>
      <li><em>Force and Torque Model of a Magnetically Levitated System with 2D Halbach
      Array and PCB Coils</em>, Sensors 23(21), 2023 —
      <a href="https://www.mdpi.com/1424-8220/23/21/8735" target="_blank" rel="noopener">open access</a>.
      Tileable 16-layer PCB stator.</li>
      <li><em>FleXstage</em>, arXiv 2309.11735 —
      <a href="https://arxiv.org/pdf/2309.11735" target="_blank" rel="noopener">PDF</a>.
      Over-actuated lightweight platen.</li>
      <li>R. Chen, <em>A New Type of Magnet Array for Planar Motor</em>, MSc, UBC —
      <a href="https://open.library.ubc.ca/media/stream/pdf/24/1.0340572/3" target="_blank" rel="noopener">PDF</a>.
      Array topologies with gaps and staggers.</li>
    </ul>`;
}

// ------------------------------------------------------------------- boot ---

setupChrome();
loadPreset('desk40');
setupDesignCharts();
setupSimCharts();
setupBuildCharts();
renderAbout();
redrawAll();
if (location.hash.length > 1) app.showTab(location.hash.slice(1));
requestAnimationFrame(frame);

// ============================================================== optimiser ===
// The search runs as a generator driven from requestAnimationFrame with a
// per-frame time budget, so a 2000-design sweep never blocks the UI.

import {
  DIMENSIONS, CATEGORICAL, OBJECTIVES, DEFAULT_CONSTRAINTS,
  search as runSearch, evaluate as evalDesign, applyCandidate, activeBounds, constraintsFor,
} from './optimise.js';
import { scatter } from './plots.js';

const opt = {
  enabled: new Set(['pitch', 'magnetThickness', 'coilPitchRatio', 'windingHeight', 'gap']),
  ranges: {},          // per-dimension search range overrides
  searchGrouping: true,
  constraints: { ...DEFAULT_CONSTRAINTS },
  autoConstraints: true,
  objective: 'accel',
  budget: 500,
  results: null,
  running: false,
  iter: null,
  raf: null,
  scatterX: 'hoverPower',
  scatterY: 'accel',
  sliceDim: 'pitch',
};

const METRIC_AXES = {
  accel: { label: 'Lateral accel (g)', get: (m) => m.accel },
  worstLift: { label: 'Worst-case lift (×)', get: (m) => m.worstLift },
  hoverPower: { label: 'Hover power (W)', get: (m) => m.hoverPower },
  deltaT: { label: 'Stator ΔT (K)', get: (m) => m.deltaT },
  currentDensity: { label: 'Current density (A/mm²)', get: (m) => m.currentDensity },
  amplifiers: { label: 'Amplifiers', get: (m) => m.amplifiers },
  gap: { label: 'Air gap (mm)', get: (m) => m.gap * 1000 },
  coils: { label: 'Coils to wind', get: (m) => m.coils },
  mass: { label: 'Platen mass (kg)', get: (m) => m.mass },
  cond: { label: 'Condition number', get: (m) => m.cond },
};

// Some dimensions are not stored directly in the config. The coil-pitch ratio
// is the honest variable (lambda/3 vs lambda/2 is what matters) but what gets
// stored is the coil pitch, so it needs its own accessor.
const DIM_VALUE = {
  coilPitchRatio: {
    get: (cfg) => cfg.translator.pitch / cfg.stator.coilPitch,
    set: (cfg, v) => { cfg.stator.coilPitch = cfg.translator.pitch / Math.max(v, 0.1); },
  },
};

function dimGet(k, cfg) {
  const d = DIMENSIONS[k];
  return DIM_VALUE[k] ? DIM_VALUE[k].get(cfg) : get(cfg, d.path);
}
function dimSet(k, cfg, v) {
  const d = DIMENSIONS[k];
  if (DIM_VALUE[k]) DIM_VALUE[k].set(cfg, v); else set(cfg, d.path, v);
}
/** The sidebar slider bounds for a dimension, i.e. the range over which the
 *  rest of the app claims to be valid. The optimiser panel's free-text boxes
 *  must not be a back door around them -- typing a 1.4 mm pole pitch into a
 *  model whose declared floor is 8 mm produces an air-gap field that has
 *  underflowed to ~1e-18 T, which is not a design, it is arithmetic. */
function dimLimits(k) {
  const d = DIMENSIONS[k];
  if (k === 'coilPitchRatio') return { lo: d.min, hi: d.max };
  const f = PARAMS.flatMap((g) => g.fields).find((x) => x.path === d.path);
  return f ? { lo: f.min, hi: f.max } : { lo: d.min, hi: d.max };
}

function dimRange(k) {
  const d = DIMENSIONS[k];
  const r = opt.ranges[k];
  return { min: r ? r.min : d.min, max: r ? r.max : d.max };
}
function dimSkipped(k) {
  const d = DIMENSIONS[k];
  return !!(d.skipIf && d.skipIf(app.cfg));
}

/** Dimensions the search will vary. Everything NOT returned here is pinned at
 *  its current config value -- that is the whole point of the checkbox. */
function optDims() {
  const d = {};
  for (const k of opt.enabled) {
    const spec = DIMENSIONS[k];
    if (!spec || dimSkipped(k)) continue;
    d[k] = { ...spec, ...dimRange(k) };
  }
  return d;
}

function buildOptUI() {
  const objSel = document.getElementById('optObjective');
  objSel.innerHTML = Object.entries(OBJECTIVES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  objSel.value = opt.objective;
  objSel.addEventListener('change', () => { opt.objective = objSel.value; });

  const budget = document.getElementById('optBudget');
  const budgetOut = document.getElementById('optBudgetOut');
  const updBudget = () => { opt.budget = +budget.value; budgetOut.textContent = `${opt.budget}`; };
  budget.addEventListener('input', updBudget); updBudget();

  renderOptDims();

  const cons = [
    ['minWorstLift', 'Min worst-case lift (× weight)', 0.1, 10, 0.1],
    ['maxDeltaT', 'Max stator ΔT (K)', 5, 200, 5],
    ['maxCurrentDensity', 'Max current density (A/mm²)', 1, 60, 1],
    ['maxAmplifiers', 'Max amplifiers', 4, 512, 4],
    ['maxCoils', 'Max coils to wind', 16, 2304, 16],
    ['minGapFraction', 'Min air gap (× platen size)', 0, 0.05, 0.0025],
  ];
  document.getElementById('optConstraints').innerHTML = cons.map(([k, l, mn, mx, st]) => `
    <div class="conrow"><label for="con-${k}">${l}</label>
      <input type="number" id="con-${k}" min="${mn}" max="${mx}" step="${st}" value="${opt.constraints[k]}"></div>`).join('')
    + `<div class="conrow"><label for="con-rank">Require full 6-DOF control</label>
        <input type="checkbox" id="con-rank" ${opt.constraints.requireRank6 ? 'checked' : ''}></div>`;
  for (const [k] of cons) {
    document.getElementById(`con-${k}`).addEventListener('change', (e) => {
      opt.constraints[k] = +e.target.value;
      if (k === 'maxCurrentDensity') opt.autoConstraints = false; // user took over
    });
  }
  document.getElementById('con-rank').addEventListener('change', (e) => {
    opt.constraints.requireRank6 = e.target.checked;
  });

  const axOpts = Object.entries(METRIC_AXES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  const sx = document.getElementById('optScatterX'), sy = document.getElementById('optScatterY');
  sx.innerHTML = axOpts; sy.innerHTML = axOpts;
  sx.value = opt.scatterX; sy.value = opt.scatterY;
  sx.addEventListener('change', () => { opt.scatterX = sx.value; redraw('optScatter'); });
  sy.addEventListener('change', () => { opt.scatterY = sy.value; redraw('optScatter'); });

  const sd = document.getElementById('optSliceDim');
  sd.innerHTML = Object.entries(DIMENSIONS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  sd.value = opt.sliceDim;
  sd.addEventListener('change', () => { opt.sliceDim = sd.value; redraw('optSlice'); });

  document.getElementById('btnOptRun').addEventListener('click', startSearch);
  document.getElementById('btnOptStop').addEventListener('click', stopSearch);
  refreshOptDimStates();
  syncOptConstraints();
}

/** Build the dimension panel. Each row is either SEARCHED (editable min/max) or
 *  PINNED (editable single value that writes straight back to the live config).
 *  Pinning is the point: with ten coupled variables you usually know four of
 *  them from the application and want the search to spend its budget on the
 *  rest. */
function renderOptDims() {
  const el = document.getElementById('optDims');
  const fmtv = (k, v) => {
    const d = DIMENSIONS[k];
    const x = v * d.scale;
    return String(Number(x.toPrecision(4)));
  };
  const nSearch = Object.keys(optDims()).length + (opt.searchGrouping ? 1 : 0);
  const nTotal = Object.keys(DIMENSIONS).filter((k) => !dimSkipped(k)).length + 1;

  let html = Object.entries(DIMENSIONS).map(([k, d]) => {
    const skipped = dimSkipped(k);
    const on = opt.enabled.has(k) && !skipped;
    const r = dimRange(k);
    const lim = dimLimits(k);
    const body = on
      ? `<input type="number" data-role="min" data-dim="${k}" value="${fmtv(k, r.min)}" step="any" min="${lim.lo * d.scale}" max="${lim.hi * d.scale}">
         <span class="dash">–</span>
         <input type="number" data-role="max" data-dim="${k}" value="${fmtv(k, r.max)}" step="any" min="${lim.lo * d.scale}" max="${lim.hi * d.scale}">`
      : `<span class="pinned">pinned</span>
         <input type="number" data-role="fix" data-dim="${k}" value="${fmtv(k, dimGet(k, app.cfg))}" step="any" min="${lim.lo * d.scale}" max="${lim.hi * d.scale}" ${skipped ? 'disabled' : ''}>`;
    return `<div class="dimrow${skipped ? ' off' : ''}" data-dim="${k}"${skipped ? ' title="Not applicable to this coil topology"' : ''}>
      <input type="checkbox" id="dim-${k}" data-toggle="${k}" ${on ? 'checked' : ''} ${skipped ? 'disabled' : ''}>
      <label for="dim-${k}">${d.label}</label>
      <span class="rangeedit">${body}<span class="unit">${d.unit}</span></span>
    </div>`;
  }).join('');

  html += `<div class="dimrow" data-dim="grouping">
    <input type="checkbox" id="dim-grouping" data-toggle="grouping" ${opt.searchGrouping ? 'checked' : ''}>
    <label for="dim-grouping">${CATEGORICAL.grouping.label}</label>
    <span class="rangeedit">${opt.searchGrouping
      ? `<span class="pinned">all ${CATEGORICAL.grouping.values.length}</span>`
      : `<span class="pinned">pinned</span>
         <select data-role="fixgrouping">${CATEGORICAL.grouping.values.map((v) =>
           `<option value="${v}"${v === app.cfg.sim.grouping ? ' selected' : ''}>${v}</option>`).join('')}</select>`}
    </span></div>`;

  html += `<div class="dimnote">Searching <b>${nSearch}</b> of ${nTotal}. Unticked
    variables are held at the value shown, and editing one here changes the live
    design immediately.</div>`;
  el.innerHTML = html;

  el.querySelectorAll('[data-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const k = cb.dataset.toggle;
      if (k === 'grouping') opt.searchGrouping = cb.checked;
      else if (cb.checked) opt.enabled.add(k); else opt.enabled.delete(k);
      renderOptDims();
    });
  });

  el.querySelectorAll('input[type="number"][data-dim]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.dim, d = DIMENSIONS[k];
      const v = (+inp.value) / d.scale;
      if (!isFinite(v)) { renderOptDims(); return; }
      const lim = dimLimits(k);
      const cl = Math.min(Math.max(v, lim.lo), lim.hi);
      if (inp.dataset.role === 'fix') {
        dimSet(k, app.cfg, cl);
        rebuild(false);
        buildParamUI();          // keep the sidebar honest about what changed
      } else {
        const r = { ...dimRange(k) };
        r[inp.dataset.role] = cl;
        if (r.min > r.max) { const t = r.min; r.min = r.max; r.max = t; }
        opt.ranges[k] = r;
      }
      if (cl !== v) {
        document.getElementById('optStatus').textContent =
          `${d.label} clamped to ${(cl * d.scale).toPrecision(3)} ${d.unit} (valid range ${(lim.lo * d.scale).toPrecision(3)}–${(lim.hi * d.scale).toPrecision(3)})`;
      }
      renderOptDims();
    });
  });

  const gsel = el.querySelector('[data-role="fixgrouping"]');
  if (gsel) {
    gsel.addEventListener('change', () => {
      app.cfg.sim.grouping = gsel.value;
      rebuild(false);
      buildParamUI();
      renderOptDims();
    });
  }
}

/** Re-derive topology-dependent constraint defaults, unless the user has
 *  overridden them by hand. */
function syncOptConstraints() {
  if (!opt.autoConstraints) return;
  const c = constraintsFor(app.cfg, DEFAULT_CONSTRAINTS);
  opt.constraints.maxCurrentDensity = c.maxCurrentDensity;
  const el = document.getElementById('con-maxCurrentDensity');
  if (el) el.value = c.maxCurrentDensity;
}

function refreshOptDimStates() {
  if (document.getElementById('optDims')) renderOptDims();
}

function startSearch() {
  if (opt.running) return;
  const dims = optDims();
  if (!Object.keys(dims).length) {
    document.getElementById('optStatus').textContent = 'select at least one dimension';
    return;
  }
  const cats = opt.searchGrouping ? CATEGORICAL : {};
  opt.running = true;
  opt.results = null;
  document.getElementById('btnOptRun').disabled = true;
  document.getElementById('btnOptStop').disabled = false;

  const explore = Math.round(opt.budget * 0.7);
  opt.iter = runSearch(app.cfg, {
    dims, cats, objective: opt.objective, constraints: opt.constraints,
    samples: explore, refineFrom: 6, refineSteps: 5,
  });

  const tick = () => {
    if (!opt.running) return;
    const t0 = performance.now();
    let r;
    do {
      r = opt.iter.next();
      if (r.done) { finishSearch(r.value); return; }
    } while (performance.now() - t0 < 28);
    const p = r.value;
    const frac = p.phase === 'explore'
      ? (p.evaluated / opt.budget) * 0.7
      : 0.7 + 0.3 * Math.min(1, (p.done ?? 0) / Math.max(p.total ?? 1, 1));
    document.getElementById('optBar').style.width = `${Math.min(100, frac * 100)}%`;
    document.getElementById('optStatus').textContent =
      `${p.phase}: ${p.evaluated} designs · best ${p.best ? fmtObjective(p.best.m) : '—'}`;
    opt.raf = requestAnimationFrame(tick);
  };
  tick();
}

function stopSearch() {
  opt.running = false;
  if (opt.raf) cancelAnimationFrame(opt.raf);
  document.getElementById('btnOptRun').disabled = false;
  document.getElementById('btnOptStop').disabled = true;
  document.getElementById('optStatus').textContent = 'stopped';
}

function fmtObjective(m) {
  const o = OBJECTIVES[opt.objective];
  return `${sig(o.get(m), 3)} ${o.unit}`;
}

function finishSearch(out) {
  opt.running = false;
  opt.results = out;
  document.getElementById('btnOptRun').disabled = false;
  document.getElementById('btnOptStop').disabled = true;
  document.getElementById('optBar').style.width = '100%';
  const feas = out.results.filter((r) => r.m.feasible).length;
  document.getElementById('optStatus').textContent =
    `${out.evaluated} designs · ${feas} feasible · ${out.pareto.length} on the Pareto front`;
  renderOptBest();
  renderOptTable();
  redraw('optScatter');
  redraw('optSlice');
}

function renderOptBest() {
  const el = document.getElementById('optBest');
  const out = opt.results;
  if (!out || !out.best || !isFinite(out.best.score)) {
    const hist = Object.entries(out?.failures ?? {}).sort((a, b) => b[1] - a[1]);
    const total = out?.results.length ?? 0;
    el.innerHTML = `<div class="card"><strong>No feasible design found.</strong>
      <div style="color:var(--muted);font-size:12px;margin-top:6px">
      Every one of ${total} candidates violated a hard constraint. What blocked them:</div>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr>
        <th>Constraint violated</th><th>Designs</th><th>Share</th></tr></thead><tbody>
      ${hist.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${((v / total) * 100).toFixed(0)}%</td></tr>`).join('')}
      </tbody></table></div>
      <div style="color:var(--muted);font-size:12px;margin-top:8px">
      The top row is the one to loosen first — anything below it may not be binding at
      all. Alternatively widen a dimension's range or enable more dimensions.</div></div>`;
    return;
  }
  const { m, cfg } = out.best;
  const p = (v, s = 1000, d = 1) => (v * s).toFixed(d);
  const bounds = out.activeBounds ?? [];
  el.innerHTML = `
    <div class="bestcard">
      <h3>Best design — ${OBJECTIVES[opt.objective].label.toLowerCase()}: ${fmtObjective(m)}</h3>
      <div class="metrics">
        <span>worst-case lift <b>${sig(m.worstLift, 3)}×</b></span>
        <span>lateral accel <b>${sig(m.accel, 3)} g</b></span>
        <span>hover <b>${sig(m.hoverPower, 3)} W</b></span>
        <span>ΔT <b>${sig(m.deltaT, 2)} K</b></span>
        <span>J <b>${sig(m.currentDensity, 2)} A/mm²</b></span>
        <span>amplifiers <b>${m.amplifiers}</b></span>
        <span>coils <b>${m.coils}</b></span>
        <span>mass <b>${sig(m.mass * 1000, 3)} g</b></span>
        <span>cond <b>${sig(m.cond, 3)}</b></span>
      </div>
      ${m.yaw?.[45] ? `<div class="metrics" style="border-top:1px solid var(--border);padding-top:8px">
        <span style="color:var(--muted)">rotated 45°:</span>
        <span>lift <b>${sig(m.yaw[45].worstLift, 3)}×</b></span>
        <span>hover <b>${sig(m.yaw[45].hoverPower, 3)} W</b></span>
        <span>lift/W <b>${sig(m.yaw[45].worstLift / Math.max(m.yaw[45].hoverPower, 1e-9), 3)}</b></span>
        <span style="color:var(--muted)">vs aligned ${sig(m.yaw[0].worstLift / Math.max(m.yaw[0].hoverPower, 1e-9), 3)}</span>
      </div>` : ''}
      <div class="params">
        <code>λ ${p(cfg.translator.pitch)} mm${cfg.translator.driveByMagnet ? ` = ${p(cfg.translator.magnetSize)} × ${cfg.translator.segments}` : ''}</code>
        ${cfg.translator.driveByMagnet ? `<code>magnet ${p(cfg.translator.magnetSize)} mm ${cfg.translator.cubicMagnets ? 'cubes' : 'blocks'}</code>` : ''}
        <code>magnet ${p(cfg.translator.magnetThickness)} mm</code>
        <code>platen ${p(cfg.translator.platenSize, 1000, 0)} mm</code>
        <code>coil pitch ${p(cfg.stator.coilPitch, 1000, 2)} mm (λ/${sig(cfg.translator.pitch / cfg.stator.coilPitch, 3)})</code>
        <code>winding ${p(cfg.stator.windingHeight)} mm</code>
        <code>wire ${p(cfg.stator.wireDiameter, 1000, 2)} mm</code>
        <code>gap ${p(cfg.sim.gap, 1000, 2)} mm</code>
        <code>drive ${cfg.sim.grouping}</code>
      </div>
      ${bounds.length ? `<div class="warnbox"><strong>${bounds.length} variable${bounds.length > 1 ? 's are' : ' is'} pinned to a search bound:</strong>
        ${bounds.map((b) => `${b.label} at its ${b.at}`).join(', ')}.
        The bound is choosing the value, not the physics — widen the range if it is not a real limit.</div>` : ''}
      <button class="primary" id="btnApplyBest">Apply this design</button>
    </div>`;
  document.getElementById('btnApplyBest').addEventListener('click', () => applyDesign(out.best.cfg));
}

/** Push a searched design back into the live config. Verifies it at full solver
 *  quality first, since the search ran coarse. */
function applyDesign(cfg) {
  const merged = JSON.parse(JSON.stringify(cfg));
  merged.sim.quality = app.cfg.sim.quality; // keep the user's solver setting
  app.cfg = merged;
  app.camDesign.userZoomed = app.camSim.userZoomed = false;
  rebuild(true);
  buildParamUI();
  refreshOptDimStates();
  // Re-check at full quality: the search deliberately runs coarse.
  const verified = evalDesign(app.cfg, opt.constraints,
    { ringsPerCoil: 3, segmentsPerSide: 5, maxOrder: 4 });
  const st = document.getElementById('optStatus');
  st.textContent = verified.feasible
    ? `applied · verified at full quality (worst-case lift ${sig(verified.worstLift, 3)}×)`
    : `applied · WARNING: fails at full quality (${verified.reason})`;
  st.className = 'status' + (verified.feasible ? '' : ' crit');
}

function renderOptTable() {
  const out = opt.results;
  if (!out) return;
  const rows = out.results.filter((r) => r.m.feasible).slice(0, 15);
  const pareto = new Set(out.pareto);
  let html = `<h4 style="font-size:12px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">
    Top feasible designs <span style="text-transform:none;font-weight:400">— click a row to load it</span></h4>`;
  if (!rows.length) { document.getElementById('optTable').innerHTML = html + '<p style="color:var(--muted);font-size:12px">None.</p>'; return; }
  html += `<div class="table-wrap"><table><thead><tr>
    <th>#</th><th>λ (mm)</th><th>gap (mm)</th><th>coil λ/n</th><th>accel (g)</th>
    <th>lift (×)</th><th>hover (W)</th><th>ΔT (K)</th><th>amps</th><th>mass (g)</th><th></th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const m = r.m, c = r.cfg;
    html += `<tr class="applyrow" data-i="${i}">
      <td>${i + 1}${pareto.has(r) ? ' ◆' : ''}</td>
      <td>${(c.translator.pitch * 1000).toFixed(1)}</td>
      <td>${(c.sim.gap * 1000).toFixed(2)}</td>
      <td>${(c.translator.pitch / c.stator.coilPitch).toFixed(2)}</td>
      <td>${sig(m.accel, 3)}</td><td>${sig(m.worstLift, 3)}</td>
      <td>${sig(m.hoverPower, 3)}</td><td>${sig(m.deltaT, 2)}</td>
      <td>${m.amplifiers}</td><td>${sig(m.mass * 1000, 3)}</td>
      <td><button class="ghost" data-apply="${i}">Apply</button></td></tr>`;
  });
  html += '</tbody></table></div><p style="color:var(--muted);font-size:11px;margin-top:6px">◆ = on the Pareto front (not beaten on every axis by any other design).</p>';
  const el = document.getElementById('optTable');
  el.innerHTML = html;
  el.querySelectorAll('[data-apply], tr.applyrow').forEach((n) => {
    n.addEventListener('click', (e) => {
      const i = +(e.currentTarget.dataset.apply ?? e.currentTarget.dataset.i);
      if (rows[i]) applyDesign(rows[i].cfg);
    });
  });
}

function setupOptCharts() {
  mountChart('optScatter', (h) => {
    const cv = document.getElementById('optScatter');
    const out = opt.results;
    const ax = METRIC_AXES[opt.scatterX], ay = METRIC_AXES[opt.scatterY];
    const pareto = new Set(out?.pareto ?? []);
    const pts = (out?.results ?? []).map((r) => ({
      x: ax.get(r.m), y: ay.get(r.m),
      cls: r === out.best && isFinite(r.score) ? 'best'
        : pareto.has(r) ? 'pareto' : r.m.feasible ? 'feasible' : 'infeasible',
      ref: r,
      label: [
        `${ax.label}: ${sig(ax.get(r.m), 3)}`,
        `${ay.label}: ${sig(ay.get(r.m), 3)}`,
        r.m.feasible ? 'feasible' : `infeasible: ${r.m.reason}`,
        `λ ${(r.cfg.translator.pitch * 1000).toFixed(1)} mm · gap ${(r.cfg.sim.gap * 1000).toFixed(2)} mm`,
      ],
    }));
    const res = scatter(cv, { points: pts, hover: h, xLabel: ax.label, yLabel: ay.label });
    opt.scatterHit = res?.hit ?? null;
  });
  document.getElementById('optScatter').addEventListener('click', () => {
    if (opt.scatterHit?.ref) applyDesign(opt.scatterHit.ref.cfg);
  });

  mountChart('optSlice', (h) => {
    const out = opt.results;
    const d = DIMENSIONS[opt.sliceDim];
    const o = OBJECTIVES[opt.objective];
    const pts = (out?.results ?? []).filter((r) => r.m.feasible && r.cand[opt.sliceDim] !== undefined)
      .map((r) => ({
        x: r.cand[opt.sliceDim] * d.scale, y: o.get(r.m), cls: 'feasible',
        label: [`${d.label}: ${sig(r.cand[opt.sliceDim] * d.scale, 3)} ${d.unit}`,
          `${o.label}: ${sig(o.get(r.m), 3)}`],
      }));
    if (out?.best && isFinite(out.best.score) && out.best.cand[opt.sliceDim] !== undefined) {
      pts.push({
        x: out.best.cand[opt.sliceDim] * d.scale, y: o.get(out.best.m), cls: 'best',
        label: ['best'],
      });
    }
    scatter(document.getElementById('optSlice'), {
      points: pts, hover: h,
      xLabel: `${d.label} (${d.unit})`, yLabel: o.label,
    });
  });
}

buildOptUI();
setupOptCharts();
