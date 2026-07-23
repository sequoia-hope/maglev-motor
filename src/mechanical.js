// Mechanical stack-up: the parts that have to physically exist.
//
// This module's job is to delete three invented numbers that the rest of the
// simulator was quietly leaning on:
//
//   platen mass  was  magnetMass * 1.6   ("+60% for structure")
//   air gap floor was 1.5% of platen size
//   cooling      was  a fixed h = 12 W/m^2K
//
// Each is now computed from parts that have a material, a thickness and a
// manufacturing process. The air gap in particular stops being a guess and
// becomes a tolerance stack -- and one of its terms is the closed-loop control
// error, which the flight simulator measures. The simulator therefore feeds the
// budget that constrains the simulator, which is the correct dependency: you
// cannot fly closer to the stator than you can hold position.

import { configFill } from './halbach.js';
import { isPcbCoil } from './coils.js';

export const MATERIALS = {
  al6061: { label: 'Aluminium 6061', rho: 2700, E: 69e9, cte: 23.6e-6, k: 167 },
  cfrp: { label: 'CFRP laminate', rho: 1600, E: 70e9, cte: 2.0e-6, k: 5 },
  fr4: { label: 'FR-4 / G10', rho: 1850, E: 22e9, cte: 16e-6, k: 0.3 },
  pom: { label: 'Acetal (POM)', rho: 1410, E: 3.1e9, cte: 110e-6, k: 0.31 },
  steel: { label: 'Steel (mild)', rho: 7850, E: 200e9, cte: 12e-6, k: 50 },
};

/** Flatness is a property of the PROCESS, not just the material. Values are
 *  achievable flatness per unit of part size. The PCB figure is the one that
 *  matters most in practice: IPC-6012 allows roughly 0.75% of the diagonal,
 *  which on a 100 mm board is 0.75 mm -- larger than the air gap of most small
 *  planar motors, and the real reason PCB stators stay small. */
export const PROCESSES = {
  lapped: { label: 'Ground / lapped', flatness: 1.0e-4, note: 'surface plate work' },
  machined: { label: 'CNC machined', flatness: 5.0e-4, note: '0.05 mm per 100 mm' },
  pcb: { label: 'PCB laminate', flatness: 7.5e-3, note: 'IPC-6012: 0.75% of diagonal' },
  printed: { label: '3-D printed', flatness: 3.0e-3, note: '0.3 mm per 100 mm' },
};

export const COOLING = {
  natural: { label: 'Natural convection', h: 12 },
  fan: { label: 'Forced air (fan)', h: 50 },
  heatsink: { label: 'Finned heatsink + fan', h: 120 },
  liquid: { label: 'Liquid cold plate', h: 700 },
};

export const DEFAULT_MECH = {
  // --- platen (moving) ---
  backingMaterial: 'al6061',
  backingThickness: 0.004,
  backingProcess: 'machined',
  pocketMaterial: 'al6061',   // the retainer the magnets sit in
  pocketWall: 0.0008,         // wall thickness between magnet cells
  magnetTolerance: 0.00005,   // +/- on magnet thickness, ground NdFeB

  // --- stator (fixed) ---
  coilHeightTolerance: 0.0002,  // per-coil build variation, NOT board flatness
  sensorThickness: 0.0016,    // Hall-array PCB, below the coils
  spreaderMaterial: 'al6061',
  spreaderThickness: 0.003,
  baseProcess: 'machined',
  cooling: 'natural',

  // --- budget ---
  controlError: 0.0001,       // 3-sigma closed-loop error; measured by the sim
  gapSafety: 0.30,            // fraction of the summed terms, held in reserve
  ambient: 25,
};

const mat = (k) => MATERIALS[k] ?? MATERIALS.al6061;
const proc = (k) => PROCESSES[k] ?? PROCESSES.machined;

/** Fraction of the magnet layer's footprint taken by retainer wall rather than
 *  magnet, for a cell pitch `cell` and wall thickness `t`. */
function wallFraction(cell, t) {
  if (!(cell > 0)) return 0;
  const open = Math.max(cell - t, 0);
  return 1 - (open * open) / (cell * cell);
}

/** Sensible mechanical defaults for a given machine. A PCB stator left
 *  free-standing warps to IPC tolerance; bonded to a machined spreader it
 *  inherits the plate's flatness instead. That single choice moves the air-gap
 *  floor by nearly a millimetre, so it is a parameter, not an assumption. */
export function mechDefaultsFor(cfg, base = DEFAULT_MECH) {
  const pcb = isPcbCoil(cfg.stator.coilType);
  return {
    ...base,
    baseProcess: pcb ? 'pcb' : 'machined',
    coilHeightTolerance: pcb ? 0.0001 : 0.0002,
  };
}

/** Full stack-up. Pure function of the config plus the mechanical parameters;
 *  returns masses, the tolerance-stack gap floor, and the thermal path. */
export function stackUp(cfg, mech = DEFAULT_MECH) {
  const m = { ...DEFAULT_MECH, ...mech };
  const P = cfg.translator.platenSize;
  const magT = cfg.translator.magnetThickness;
  const S = cfg.stator.statorSize;
  const cellPitch = cfg.translator.pitch / Math.max(cfg.translator.segments, 1);

  // ---- platen mass, from actual parts -------------------------------------
  const area = P * P;
  const wf = wallFraction(cellPitch, m.pocketWall);
  // Cells at a null in the magnetisation pattern hold no magnet -- the empty
  // corners of a 2-D Halbach array. They are pocketed like any other cell, so
  // the retainer is unchanged, but there is nothing in them to buy or to lift.
  const fill = configFill(cfg.translator);
  const magnetVol = area * magT * (1 - wf) * fill;
  const pocketVol = area * magT * wf;
  const backingVol = area * m.backingThickness;

  const magnetMass = magnetVol * 7500;                       // NdFeB
  const pocketMass = pocketVol * mat(m.pocketMaterial).rho;
  const backingMass = backingVol * mat(m.backingMaterial).rho;
  const adhesiveMass = area * 1e-4 * 1100;                   // ~0.1 mm bond line
  const platenMass = magnetMass + pocketMass + backingMass + adhesiveMass;

  // ---- thermal path: conduction through the spreader, then convection -----
  const cool = COOLING[m.cooling] ?? COOLING.natural;
  const statorArea = S * S;
  // Through-thickness conduction only. This is nearly always negligible next to
  // the convection term; the spreader earns its keep by making the WHOLE stator
  // area convect, which is the assumption baked into rConv below.
  const rCond = m.spreaderThickness / (mat(m.spreaderMaterial).k * Math.max(statorArea, 1e-9));
  const rConv = 1 / Math.max(cool.h * statorArea * 2, 1e-9);
  const rTotal = rCond + rConv;                               // K/W

  // ---- tolerance stack: what the air gap is actually made of --------------
  // Flatness scales with part size; a bigger machine is a flatter machine only
  // if you pay for it.
  const statorFlat = proc(m.baseProcess).flatness * S;
  const platenFlat = proc(m.backingProcess).flatness * P;
  // Only the LOCAL coil-to-coil build variation belongs here. The flatness of
  // the surface the coils are mounted on is already counted as statorFlat --
  // charging the board's warp twice inflated the floor by ~75%.
  const coilFlat = m.coilHeightTolerance;

  // Out-of-plane growth of both stacks at the operating temperature rise. The
  // rise is not known until the design is evaluated, so callers pass it in;
  // without it this term uses a nominal 20 K.
  const dT = isFinite(m.deltaT) ? m.deltaT : 20;
  const statorStack = m.spreaderThickness + m.sensorThickness + (cfg.stator.windingHeight ?? 0.002);
  const platenStack = magT + m.backingThickness;
  const thermalGrowth = dT * (mat(m.spreaderMaterial).cte * statorStack
    + mat(m.backingMaterial).cte * platenStack);

  const terms = [
    { key: 'statorFlat', label: 'Stator baseplate flatness', v: statorFlat, note: proc(m.baseProcess).label },
    { key: 'platenFlat', label: 'Platen flatness', v: platenFlat, note: proc(m.backingProcess).label },
    { key: 'coilFlat', label: 'Coil height variation', v: coilFlat, note: 'coil-to-coil build tolerance' },
    { key: 'magnetTol', label: 'Magnet thickness tolerance', v: m.magnetTolerance, note: 'ground NdFeB' },
    { key: 'thermal', label: 'Thermal expansion', v: thermalGrowth, note: `at ${dT.toFixed(0)} K rise` },
    { key: 'control', label: 'Control error (3σ)', v: m.controlError, note: 'measured by the flight sim' },
  ];
  const sum = terms.reduce((a, t) => a + t.v, 0);
  const safety = sum * m.gapSafety;
  terms.push({ key: 'safety', label: 'Safety margin', v: safety, note: `${(m.gapSafety * 100).toFixed(0)}% of the stack` });
  const gapFloor = sum + safety;

  // ---- assembly hazard: how hard neighbouring magnets push ----------------
  // Order-of-magnitude only: magnetic pressure B^2/(2*mu0) over the facing area
  // of adjacent cells. It is an upper bound (real Halbach neighbours meet at
  // 90 degrees, so the load is largely shear) but it is the number that decides
  // whether the retainer walls survive assembly -- and whether assembly is
  // safe to do by hand.
  const Br = cfg.translator.Br;
  const pressure = (Br * Br) / (2 * 4e-7 * Math.PI);          // Pa
  const faceArea = cellPitch * magT;
  const neighbourForce = pressure * faceArea;
  const wallArea = m.pocketWall * magT;
  const wallStress = wallArea > 0 ? neighbourForce / wallArea : Infinity;

  const layers = [
    { name: 'Platen backing plate', t: m.backingThickness, material: mat(m.backingMaterial).label, side: 'platen', mass: backingMass },
    { name: 'Magnet retainer + magnets', t: magT, material: `${mat(m.pocketMaterial).label} / NdFeB`, side: 'platen', mass: magnetMass + pocketMass + adhesiveMass },
    { name: 'AIR GAP', t: cfg.sim.gap, material: '—', side: 'gap' },
    { name: 'Coil layer', t: cfg.stator.windingHeight ?? 0.002, material: 'copper / former', side: 'stator' },
    { name: 'Hall sensor PCB', t: m.sensorThickness, material: mat('fr4').label, side: 'stator' },
    { name: 'Thermal spreader', t: m.spreaderThickness, material: mat(m.spreaderMaterial).label, side: 'stator' },
  ];

  return {
    mech: m, layers, terms,
    platenMass, magnetMass, pocketMass, backingMass, adhesiveMass,
    wallFraction: wf, cellPitch, magnetFill: fill,
    gapFloor, gapTermSum: sum,
    thermalResistance: rTotal, rCond, rConv, coolingLabel: cool.label,
    neighbourForce, wallStress,
    statorStackHeight: statorStack,
    platenStackHeight: platenStack,
  };
}

/** Steady-state stator temperature rise for a given copper loss, using the
 *  computed thermal path instead of a bare convection coefficient. */
export function stackTemperatureRise(power, stack) {
  return power * stack.thermalResistance;
}
