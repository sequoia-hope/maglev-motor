// Exploded assembly: the step between "this design works" and "this is what I
// have to buy and make".
//
// Everything here is derived, never described. The parts list is generated from
// the same config the physics runs on, at the same z positions the field model
// integrates over, so the drawing cannot drift from the simulation -- if the
// stack-up says the coil layer is 3 mm tall, the coil layer in the drawing is
// 3 mm tall, and the air gap in the drawing is the air gap the wrench matrix
// was built at.
//
// What it deliberately does NOT invent: fasteners, connectors, cable routing,
// and the stator frame. Those are real parts, but nothing in the model
// determines their size, and a made-up screw pattern in an otherwise-derived
// drawing is worse than an absent one. They are called out as missing instead.

import { MATERIALS, PROCESSES } from './mechanical.js';
import { cellsAcross } from './halbach.js';

// Nearest standard NdFeB grade for a given remanence. Buying is done by grade,
// not by Br, so the BOM has to speak the catalogue's language.
const GRADES = [
  { name: 'N35', Br: 1.19 }, { name: 'N38', Br: 1.24 }, { name: 'N42', Br: 1.30 },
  { name: 'N45', Br: 1.34 }, { name: 'N48', Br: 1.38 }, { name: 'N52', Br: 1.44 },
];

export function nearestGrade(Br) {
  let best = GRADES[0];
  for (const g of GRADES) if (Math.abs(g.Br - Br) < Math.abs(best.Br - Br)) best = g;
  return { ...best, exact: Math.abs(best.Br - Br) < 0.015 };
}

/** Standard AWG for a wire diameter, so the winding schedule is orderable. */
const AWG = [
  [18, 1.024], [20, 0.812], [22, 0.644], [24, 0.511], [26, 0.405],
  [28, 0.321], [30, 0.255], [32, 0.202], [34, 0.160], [36, 0.127],
];
export function nearestAWG(dMetres) {
  const mm = dMetres * 1000;
  let best = AWG[0];
  for (const a of AWG) if (Math.abs(a[1] - mm) < Math.abs(best[1] - mm)) best = a;
  return { gauge: best[0], nominal: best[1] };
}

const mat = (k) => MATERIALS[k] ?? MATERIALS.al6061;

const AZ_NAMES = { 0: '+x', 45: '+x+y', 90: '+y', 135: '−x+y', 180: '−x', 225: '−x−y', 270: '−y', 315: '+x−y' };

/** Classify a cell's magnetisation the way a supplier's catalogue does.
 *
 *  This is not cosmetic. A block magnetised through its thickness and one
 *  magnetised through its length are both commodity stock; a block magnetised
 *  along a body diagonal is a custom order at several times the price and
 *  weeks of lead time. Bucketing anything with |mz| above some threshold as
 *  "axial" hides exactly that distinction -- which is what the first version of
 *  this function did, and it reported every preset as 100% axial when in fact
 *  not one magnet in the model is axial. */
function directionOf(mx, my, mz, Br) {
  const mag = Math.hypot(mx, my, mz) || 1;
  const elev = (Math.asin(Math.max(-1, Math.min(1, mz / mag))) * 180) / Math.PI;
  const azDeg = ((Math.round((Math.atan2(my, mx) * 180) / Math.PI / 45) * 45) % 360 + 360) % 360;
  const az = AZ_NAMES[azDeg] ?? `${azDeg}°`;

  if (Math.abs(elev) > 80) {
    return { key: elev > 0 ? 'up' : 'down', cls: 'axial',
      label: elev > 0 ? 'Axial ↑ (out of platen)' : 'Axial ↓ (into gap)' };
  }
  if (Math.abs(elev) < 10) {
    return { key: `p${azDeg}`, cls: 'in-plane', label: `In-plane ${az}` };
  }
  const e = Math.round(elev);
  return { key: `d${e}_${azDeg}`, cls: 'diagonal',
    label: `Diagonal ${e > 0 ? '+' : ''}${e}° elev, ${az}` };
}

/** Walk the platen exactly the way the renderer does, so the magnet count in
 *  the BOM is the magnet count in the picture. */
export function magnetCensus(tr) {
  const tile = tr.tile;
  const cellW = tile.lx / tile.nx, cellH = tile.ly / tile.ny;
  const bins = new Map();
  let total = 0;
  for (const pt of tr.patches) {
    const nu = cellsAcross(pt.w, cellW), nv = cellsAcross(pt.h, cellH);
    for (let jv = 0; jv < nv; jv++) {
      for (let iu = 0; iu < nu; iu++) {
        const px = -pt.w / 2 + (iu + 0.5) * cellW;
        const py = -pt.h / 2 + (jv + 0.5) * cellH;
        const tx = ((px % tile.lx) + tile.lx) % tile.lx;
        const ty = ((py % tile.ly) + tile.ly) % tile.ly;
        const ci = Math.min(tile.nx - 1, Math.floor((tx / tile.lx) * tile.nx));
        const cj = Math.min(tile.ny - 1, Math.floor((ty / tile.ly) * tile.ny));
        const k = (cj * tile.nx + ci) * 3;
        const d = directionOf(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2], tile.Br);
        const cur = bins.get(d.key) ?? { ...d, n: 0 };
        cur.n++;
        bins.set(d.key, cur);
        total++;
      }
    }
  }
  const rows = [...bins.values()].sort((a, b) => b.n - a.n);
  // Orientation on the platen is an assembly step, not a different part -- so
  // what you actually order is one SKU per magnetisation CLASS, not one per
  // direction. That collapse only works for axial and in-plane blocks; a
  // diagonal one is its own custom part.
  const count = (c) => rows.filter((r) => r.cls === c).reduce((a, r) => a + r.n, 0);
  const axial = count('axial'), inPlane = count('in-plane'), diagonal = count('diagonal');
  const skus = ['axial', 'in-plane', 'diagonal'].filter((c) => count(c) > 0);
  return { rows, total, axial, inPlane, diagonal, skus, cellW, cellH };
}

/** The full parts list, bottom of the stator to top of the platen.
 *  z0/z1 are TRUE assembly coordinates: z = 0 is the top of the coils, the
 *  plane the quoted air gap is measured from. */
export function buildAssembly(cfg, stack, tr, stator) {
  const P = cfg.translator.platenSize;
  const S = cfg.stator.statorSize;
  const magT = cfg.translator.magnetThickness;
  const gap = cfg.sim.gap;
  const m = stack.mech;
  const census = magnetCensus(tr);
  const grade = nearestGrade(cfg.translator.Br);

  // Coil layer occupies whatever span the coils actually sit in -- a racetrack
  // stator has two banks at different depths, and pretending it is one layer
  // would understate the stator's height by most of a winding.
  let coilTop = -Infinity, coilBot = Infinity;
  for (const c of stator.coils) {
    coilTop = Math.max(coilTop, c.z + stator.thickness / 2);
    coilBot = Math.min(coilBot, c.z - stator.thickness / 2);
  }
  const coilSpan = coilTop - coilBot;

  const sensorTop = coilBot;
  const spreaderTop = sensorTop - m.sensorThickness;

  const wireLen = stator.coils.reduce((L, c) => L + c.turns * 2 * (c.outer[0] + c.outer[1]), 0);
  const awg = nearestAWG(cfg.stator.wireDiameter);
  const isPcbCoil = cfg.stator.coilType === 'pcb';

  const grey = [176, 174, 166];
  const parts = [
    {
      id: 'spreader', name: 'Thermal spreader / base plate', side: 'stator',
      kind: 'slab', size: S, t: m.spreaderThickness, z0: spreaderTop - m.spreaderThickness,
      material: mat(m.spreaderMaterial).label, process: PROCESSES[m.baseProcess]?.label ?? '—',
      qty: 1, mass: S * S * m.spreaderThickness * mat(m.spreaderMaterial).rho,
      rgb: [150, 148, 142],
      spec: `${(S * 1000).toFixed(0)} × ${(S * 1000).toFixed(0)} × ${(m.spreaderThickness * 1000).toFixed(1)} mm`,
      note: `Carries ${stack.thermalResistance.toFixed(2)} K/W to ${stack.coolingLabel.toLowerCase()}. Its flatness is ${((stack.terms.find((t) => t.key === 'statorFlat')?.v ?? 0) * 1000).toFixed(2)} mm of the air-gap budget.`,
      critical: 'Flatness — this face sets the whole stator datum.',
    },
    {
      id: 'sensor', name: 'Hall-sensor PCB', side: 'stator',
      kind: 'slab', size: S, t: m.sensorThickness, z0: sensorTop - m.sensorThickness,
      material: mat('fr4').label, process: 'PCB fab',
      qty: 1, mass: S * S * m.sensorThickness * mat('fr4').rho,
      rgb: [46, 110, 74],
      spec: `${(S * 1000).toFixed(0)} × ${(S * 1000).toFixed(0)} × ${(m.sensorThickness * 1000).toFixed(1)} mm`,
      note: 'Position feedback. Sits under the coils so it sees the platen field through the winding, not around it.',
      critical: 'Sensor count and layout are NOT modelled here — the sim assumes perfect state feedback.',
    },
    {
      id: 'coils', name: isPcbCoil ? 'Coil board (PCB spirals)' : 'Coil array', side: 'stator',
      kind: 'coils', size: S, t: coilSpan, z0: coilBot,
      material: isPcbCoil ? 'copper on FR-4' : 'magnet wire on former',
      process: isPcbCoil ? 'PCB fab' : 'wound',
      qty: stator.coils.length,
      mass: stator.copperMass,
      rgb: [186, 116, 62],
      spec: isPcbCoil
        ? `${stator.coils.length} spirals, ${stator.effTurns} turns each (${cfg.stator.pcbLayers} layers)`
        : `${stator.coils.length} coils, ${stator.effTurns} turns of AWG ${awg.gauge}`,
      note: isPcbCoil
        ? `${(wireLen).toFixed(0)} m of trace, ${(stator.copperMass * 1000).toFixed(0)} g of copper, ${(stator.coils[0]?.R ?? 0).toFixed(2)} Ω per coil.`
        : `${wireLen.toFixed(0)} m of wire total, ${(wireLen / Math.max(stator.coils.length, 1)).toFixed(1)} m per coil, ${(stator.coils[0]?.R ?? 0).toFixed(2)} Ω each.`,
      critical: 'Build height variation between coils is ±' + (m.coilHeightTolerance * 1000).toFixed(2) + ' mm in the gap budget.',
    },
    {
      id: 'gap', name: 'AIR GAP', side: 'gap', kind: 'gap', size: P, t: gap, z0: 0,
      material: '—', process: '—', qty: 1, mass: 0, rgb: [0, 0, 0],
      spec: `${(gap * 1000).toFixed(2)} mm`,
      note: `Tolerance stack demands at least ${(stack.gapFloor * 1000).toFixed(2)} mm.`,
      critical: gap >= stack.gapFloor ? null : 'Design gap is below the tolerance floor — it will touch down.',
    },
    {
      id: 'magnets', name: 'Halbach magnet array', side: 'platen',
      kind: 'magnets', size: P, t: magT, z0: gap,
      material: `NdFeB ${grade.name}`, process: 'sintered, ground',
      qty: census.total, mass: stack.magnetMass,
      rgb: [120, 120, 130],
      spec: `${census.total} cells of ${(census.cellW * 1000).toFixed(1)} × ${(census.cellH * 1000).toFixed(1)} × ${(magT * 1000).toFixed(1)} mm`,
      note: `${census.axial} axial, ${census.inPlane} in-plane, ${census.diagonal} diagonal. `
        + `Br ${cfg.translator.Br.toFixed(2)} T ${grade.exact ? '=' : '≈'} ${grade.name}.`,
      critical: census.diagonal > 0
        ? `${census.diagonal} of ${census.total} cells are diagonally magnetised — a custom order, not catalogue stock. See the magnet order card.`
        : `Neighbours push ~${stack.neighbourForce.toFixed(0)} N apart during assembly.`,
    },
    {
      id: 'retainer', name: 'Magnet retainer (pocketed)', side: 'platen',
      kind: 'retainer', size: P, t: magT, z0: gap,
      wall: m.pocketWall, cell: census.cellW,
      material: mat(m.pocketMaterial).label, process: PROCESSES[m.backingProcess]?.label ?? '—',
      qty: 1, mass: stack.pocketMass,
      rgb: [196, 194, 186],
      spec: `${census.total} pockets, ${(m.pocketWall * 1000).toFixed(2)} mm walls`,
      note: `Occupies the same layer as the magnets and displaces ${(stack.wallFraction * 100).toFixed(0)}% of them — field you do not get.`,
      critical: `Walls see ~${(stack.wallStress / 1e6).toFixed(1)} MPa from magnet repulsion.`,
    },
    {
      id: 'backing', name: 'Platen backing plate', side: 'platen',
      kind: 'slab', size: P, t: m.backingThickness, z0: gap + magT,
      material: mat(m.backingMaterial).label, process: PROCESSES[m.backingProcess]?.label ?? '—',
      qty: 1, mass: stack.backingMass,
      rgb: grey,
      spec: `${(P * 1000).toFixed(0)} × ${(P * 1000).toFixed(0)} × ${(m.backingThickness * 1000).toFixed(1)} mm`,
      note: `Structure and payload interface. ${(stack.backingMass / stack.platenMass * 100).toFixed(0)}% of the flying mass.`,
      critical: 'Stiffness is NOT modelled — a plate too thin to hold its own shape will not be caught here.',
    },
  ];

  // Adhesive is a mass, not a drawable layer: at 0.1 mm it would be a sub-pixel
  // sliver in the view but it is 1-8% of the platen, so it belongs in the BOM.
  const consumables = [
    {
      id: 'adhesive', name: 'Structural adhesive', qty: '~1 bond line',
      material: 'epoxy', spec: '≈0.1 mm bond line', mass: stack.adhesiveMass,
      note: 'Bonds magnets into pockets and the retainer to the backing plate.',
    },
  ];

  // --- sourcing -------------------------------------------------------------
  // The tile samples its magnetisation at CELL CENTRES. For an N-segment array
  // that puts every block half a cell off the axis, which for the common
  // 4-segment case means every magnet is on a body diagonal -- custom parts,
  // for a pattern that was never chosen deliberately. Shifting the sampling
  // origin by half a cell is a rigid translation of the magnetisation, so the
  // harmonics are unchanged in magnitude (verified to 0.0000% in
  // test/assembly.test.mjs) and the same array becomes commodity stock.
  const sourcing = census.diagonal > 0 ? {
    problem: `${census.diagonal} of ${census.total} cells are magnetised on a diagonal.`,
    cause: 'The magnetisation tile is sampled at cell centres, which offsets every block by half a cell from the array axis.',
    remedy: 'Shift the tile origin half a cell. That is a rigid translation of the platen — identical field, identical forces — and it lands every block on an axis.',
    after: census.total % 2 === 0
      ? `${census.total / 2} through-thickness + ${census.total / 2} through-length, both catalogue items.`
      : 'Blocks land on axes: through-thickness and through-length, both catalogue items.',
  } : null;

  const movingMass = parts.filter((p) => p.side === 'platen').reduce((a, p) => a + p.mass, 0)
    + stack.adhesiveMass;
  const fixedMass = parts.filter((p) => p.side === 'stator').reduce((a, p) => a + p.mass, 0);

  return {
    parts, consumables, census, grade, awg, sourcing,
    movingMass, fixedMass,
    statorHeight: coilTop - (spreaderTop - m.spreaderThickness),
    platenHeight: magT + m.backingThickness,
    // Stated so the drawing is honest about its own edges.
    notModelled: [
      'Fasteners, standoffs and the stator frame — nothing in the model sets their size.',
      'Coil terminations, wiring harness and connector positions.',
      `Driver electronics: ${cfg.sim.grouping === 'none' ? stator.coils.length : 'grouped'} channels have to physically land somewhere.`,
      'Plate stiffness and deflection under load — flatness here comes from the process, not a deflection calculation.',
    ],
  };
}
