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
import { eachCell, cellSize } from './halbach.js';
import { isPcbCoil } from './coils.js';

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

// Real, ORDERABLE catalogue parts, keyed by block footprint / thickness / grade.
// The magnet order table above already says "through-thickness (stock)" in the
// abstract; this turns that into a specific part number and price when the
// design's block matches something a supplier actually stocks. Only verified
// SKUs go in here -- an unmatched design gets the generic guidance, never an
// invented part number, which is the whole point of keeping it a lookup rather
// than a sentence in a blurb. Dimensions in mm; `for` is the census class the
// line covers ('axial', 'in-plane', or 'both' when one SKU serves both roles).
const MAGNET_CATALOGUE = [
  {
    // pcbmini: a 6×6×3 checkerboard needs an axial block and an in-plane block.
    // The in-plane one is NOT a custom magnetisation -- it is the stock 6×3×6
    // size laid on its side, where the 3 mm dimension stands up and one of the
    // two equal 6 mm edges is the (horizontal) magnetised axis. Two catalogue
    // SKUs, no custom order. Verified 2026-07 on suprememagnets.com.
    w: 6, h: 6, t: 3, grade: 'N52', tol: 0.25, vendor: 'Supreme Magnets', verified: '2026-07',
    lines: [
      { for: 'axial', order: '6 × 6 × 3 mm N52, magnetised through the 3 mm',
        url: 'https://suprememagnets.com/products/neodymium-magnet-6x6x3mm-block', unit: 0.70 },
      { for: 'in-plane', order: '6 × 3 × 6 mm N52, magnetised through a 6 mm edge — laid 3 mm-up it is the in-plane block',
        url: 'https://suprememagnets.com/products/neodymium-magnet-6x3x6mm-block', unit: 0.49 },
    ],
    note: 'The in-plane block is a stock 6×3×6 on its side, so both magnetisations are catalogue items — no custom order, no lead time.',
  },
  {
    // amz316: a true cube is magnetised through thickness only, but rotating it
    // 90° gives an in-plane dipole with the SAME footprint, so one SKU is the
    // whole platen. Verified against amazingmagnets.com (see the amz316 blurb).
    w: 4.7625, h: 4.7625, t: 4.7625, grade: 'N52', tol: 0.15, vendor: 'Amazing Magnets', verified: '2026-07',
    lines: [
      { for: 'both', order: '3/16″ (4.76 mm) N52 cube, C188A2-N52, magnetised through thickness',
        url: 'https://amazingmagnets.com/C188A2-N52/', unit: 0.56 },
    ],
    note: 'One part number for the entire platen: a true cube turned in the jig is the in-plane block.',
  },
  {
    // desk40: a 5 mm cube is the smallest true-cube that keeps the platen a
    // catalogue build. Like every cube, one SKU is the whole array -- axial as
    // supplied, in-plane turned 90° in the jig. Verified 2026-07 on jc-magnetics.
    w: 5, h: 5, t: 5, grade: 'N52', tol: 0.15, vendor: 'JC Magnetics', verified: '2026-07',
    lines: [
      { for: 'both', order: '5 mm N52 cube, JCN52-BLK555, magnetised through thickness (turned 90° in the jig for the in-plane block)',
        url: 'https://www.jc-magnetics.com/Magnet-N52-5mmx5mmx5mm-Cube', unit: 0.62 },
    ],
    note: 'One part number for the whole platen: a true 5 mm cube, axial as supplied and in-plane turned 90°.',
  },
  {
    // wire100: the 10 mm platen wants a bigger block, and a 10 mm cube is a stock
    // single-SKU part -- no through-length partner to hunt down (which, for a
    // Halbach checkerboard, does not exist off the shelf above ~6 mm). Verified
    // 2026-07 on suprememagnets.com.
    w: 10, h: 10, t: 10, grade: 'N52', tol: 0.20, vendor: 'Supreme Magnets', verified: '2026-07',
    lines: [
      { for: 'both', order: '10 mm N52 cube, magnetised through thickness (turned 90° for the in-plane block)',
        url: 'https://suprememagnets.com/products/neodymium-magnet-10mm-cube', unit: 2.48 },
    ],
    note: 'One part number for the whole platen: a true 10 mm cube reused in two orientations.',
  },
];

/** Concrete order plan for a census, or null when no verified catalogue part
 *  matches the design's block. Fills in the counts and costs from the census so
 *  the totals track the actual array, empties and all. */
function catalogueOrder(census, magTmm, gradeName) {
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const e = MAGNET_CATALOGUE.find((c) => c.grade === gradeName
    && near(c.w, census.cellW * 1000, c.tol) && near(c.h, census.cellH * 1000, c.tol)
    && near(c.t, magTmm, c.tol));
  if (!e) return null;
  const qtyFor = (f) => f === 'both' ? census.axial + census.inPlane
    : f === 'axial' ? census.axial : f === 'in-plane' ? census.inPlane : 0;
  const lines = e.lines.map((l) => {
    const qty = qtyFor(l.for);
    return { ...l, qty, cost: qty * l.unit };
  }).filter((l) => l.qty > 0);
  const total = lines.reduce((a, l) => a + l.cost, 0);
  return { vendor: e.vendor, verified: e.verified, note: e.note, lines, total, skus: lines.length };
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
  const mag = Math.hypot(mx, my, mz);
  // A null in the pattern is an empty pocket, not a magnet. Falling through to
  // the azimuth branch would bill it as an in-plane block -- 25% of a 2-D
  // Halbach array bought, weighed and drawn as parts that are not there.
  if (mag < 1e-9 * (Br || 1)) return { key: 'empty', cls: 'empty', label: 'Empty pocket (pattern null)' };
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
  const [cellW, cellH] = cellSize(tile);
  const bins = new Map();
  let cells = 0;
  eachCell(tile, tr.patches, (_px, _py, k) => {
    const d = directionOf(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2], tile.Br);
    const cur = bins.get(d.key) ?? { ...d, n: 0 };
    cur.n++;
    bins.set(d.key, cur);
    cells++;
  });
  const rows = [...bins.values()].sort((a, b) => b.n - a.n);
  // Orientation on the platen is an assembly step, not a different part -- so
  // what you actually order is one SKU per magnetisation CLASS, not one per
  // direction. That collapse only works for axial and in-plane blocks; a
  // diagonal one is its own custom part.
  const count = (c) => rows.filter((r) => r.cls === c).reduce((a, r) => a + r.n, 0);
  const axial = count('axial'), inPlane = count('in-plane'), diagonal = count('diagonal');
  const empty = count('empty');
  const skus = ['axial', 'in-plane', 'diagonal'].filter((c) => count(c) > 0);
  // `total` is what you buy; `cells` is what you pocket. They differ by the
  // empty positions, and conflating them is how a BOM orders magnets for holes.
  return { rows, cells, total: cells - empty, axial, inPlane, diagonal, empty, skus, cellW, cellH };
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
  const isPcb = isPcbCoil(cfg.stator.coilType);

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
      id: 'coils', name: isPcb ? 'Coil board (PCB spirals)' : 'Coil array', side: 'stator',
      kind: 'coils', size: S, t: coilSpan, z0: coilBot,
      material: isPcb ? 'copper on FR-4' : 'magnet wire on former',
      process: isPcb ? 'PCB fab' : 'wound',
      qty: stator.coils.length,
      mass: stator.copperMass,
      rgb: [186, 116, 62],
      spec: isPcb
        ? `${stator.coils.length} spirals, ${stator.effTurns} turns each (${cfg.stator.pcbLayers} layers)`
        : `${stator.coils.length} coils, ${stator.effTurns} turns of AWG ${awg.gauge}`,
      note: isPcb
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
      spec: `${census.total} blocks of ${(census.cellW * 1000).toFixed(1)} × ${(census.cellH * 1000).toFixed(1)} × ${(magT * 1000).toFixed(1)} mm`,
      note: `${census.axial} axial, ${census.inPlane} in-plane, ${census.diagonal} diagonal`
        + (census.empty ? `, ${census.empty} of ${census.cells} cells left empty (pattern nulls). ` : '. ')
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
      spec: `${census.cells} pockets, ${(m.pocketWall * 1000).toFixed(2)} mm walls`,
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
  // This used to fire on every preset: the tile was sampled at CELL CENTRES,
  // which offsets each block half a cell from the pattern's own axis, and for
  // the common 4-segment array that put every magnet on a body diagonal --
  // custom parts, for a geometry nobody chose. halbach.js now samples the
  // aligned arrays at the cell edge instead, a rigid half-cell translation that
  // leaves every harmonic's magnitude untouched (checked in
  // test/assembly.test.mjs) and lands every block on an axis.
  //
  // What is left is the case where no shift can help: the 45-degree array's
  // pattern axes are diagonal to its cells by construction, so half its blocks
  // are genuinely custom parts. That is a property of the topology, and the only
  // remedy is a different topology.
  const sourcing = census.diagonal > 0 ? {
    problem: `${census.diagonal} of ${census.total} blocks are magnetised on a body diagonal.`,
    cause: 'This array\'s pattern axes sit at 45° to its cells, so no shift of the tile origin can bring the blocks onto an axis — the diagonals are the topology, not a sampling artefact.',
    remedy: 'Switch to the checkerboard array (halbach2d), whose blocks are all axial or in-plane, or accept a custom magnetisation at several times the price and weeks of lead time.',
    after: 'On the checkerboard: through-thickness and through-length blocks only, both catalogue items, with one cell in four left empty.',
  } : null;

  const movingMass = parts.filter((p) => p.side === 'platen').reduce((a, p) => a + p.mass, 0)
    + stack.adhesiveMass;
  const fixedMass = parts.filter((p) => p.side === 'stator').reduce((a, p) => a + p.mass, 0);

  const orderPlan = catalogueOrder(census, magT * 1000, grade.name);

  return {
    parts, consumables, census, grade, awg, sourcing, orderPlan,
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
