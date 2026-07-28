// analysis.js is the Design tab's brain -- fieldCrossCheck, the flux-sensor
// cards, the layout recommender -- and until now it ran only in the browser,
// where nothing holds its numbers to the model. These checks pin the claims the
// cards make. Two of them are regressions for real bugs: fieldCrossCheck used
// to lay a 9x9 reference to check a 7x7 platen (understating the edge error it
// exists to report), and the sensor card's saturation ceiling promised
// "self+neighbours+mover" while delivering only the coils.

import { makeTranslator } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { magnetCensus } from '../src/assembly.js';
import {
  fieldCrossCheck, sensorObservability, poseObservability, sensorLayout, liftVsGap,
} from '../src/analysis.js';

let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fails++; };

// The small PCB stage: 48 mm platen, lambda = 24 mm, 33 magnets in 7x7 -- the
// most edge-dominated platen that ships, so the finite-array check matters most.
const tcfg = {
  arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.003,
  Br: 1.43, segments: 4, platenSize: 0.048, platenMass: 0, maxOrder: 3, gap: 0.0015,
};
const tr = makeTranslator(tcfg);
const stator = makeStator({
  coilType: 'pcbhex', coilPitch: 0.008, coilFill: 0.84, statorSize: 0.096,
  windingHeight: 0.0016, wireDiameter: 0.0005, pcbLayers: 12, pcbSpareLayers: 1,
  pcbTraceWidth: 0.000103, pcbCopperThickness: 35e-6,
  ringsPerCoil: 2, segmentsPerSide: 3,
});

console.log('=== fieldCrossCheck checks the array the BOM ships ===');
{
  const fc = fieldCrossCheck(tr);
  check('cross-check is available for a single-array layout', fc.available === true);
  // The regression: the reference must be the BILLED array, not a re-derived
  // extent. It once laid 65 cells to check a 33-magnet platen; a bigger array
  // has less edge error, so the check flattered the very thing it reports.
  const census = magnetCensus(tr);
  check('reference cell count equals the billed magnet count',
    fc.nCells === census.total, `${fc.nCells} vs census ${census.total}`);
  // Frame regression: exact field of the physical cells vs fieldAt (the entry
  // point the physics uses, tr.phase inside). Mixing frames costs ~60% of peak
  // component-wise, so a loose few-percent bound still pins it hard.
  check('core agreement is a few percent (frames not mixed)',
    fc.coreRms < 0.12, `core RMS ${(fc.coreRms * 100).toFixed(1)}% of peak`);
  check('true peak |B| agrees between exact and harmonic',
    fc.peakErr < 0.08, `${(fc.peakErr * 100).toFixed(1)}%`);
  check('rim error exceeds core error (edges are real)',
    fc.rimRms > fc.coreRms, `rim ${(fc.rimRms * 100).toFixed(1)}% vs core ${(fc.coreRms * 100).toFixed(1)}%`);
  check('a 2-wavelength platen reads as one',
    Math.abs(fc.wavelengths - 2) < 0.26, `${fc.wavelengths.toFixed(2)} wavelengths`);
}

console.log('\n=== sensor observability: the physics the card claims ===');
{
  const so = sensorObservability(stator, tr, { iRef: 1.0, gap: 0.0015 });
  check('check is available', so.available === true, `${so.nSensors} sensors scored`);
  check('planar-coil self-field at its centre is (almost) purely Bz',
    so.selfInPlaneShare < 0.05, `in-plane share ${(so.selfInPlaneShare * 100).toFixed(2)}%`);
  check('the board eats a real fraction of the mover field, not all of it',
    so.boardLoss > 0.1 && so.boardLoss < 0.95, `${(so.boardLoss * 100).toFixed(0)}% lost`);
  check('in-plane axes are cleaner than Bz (the 3-axis argument)',
    so.cleanFactor > 3, `${so.cleanFactor.toFixed(1)}x cleaner`);
  check('Bz calibration tolerance is the binding one',
    so.calVert < so.calIn, `Bz ${(so.calVert * 100).toFixed(1)}% vs in-plane ${(so.calIn * 100).toFixed(1)}%`);
  // Regression: the saturation ceiling must include the MOVER, not just the
  // coils. At iRef = 0 the coil term vanishes, so what remains IS the mover
  // field through the board -- if the ceiling ignored the magnets it would
  // read zero here.
  const so0 = sensorObservability(stator, tr, { iRef: 0, gap: 0.0015 });
  check('saturation ceiling includes the mover field (survives iRef = 0)',
    so0.fullScale > 0.005, `${(so0.fullScale * 1000).toFixed(1)} mT at zero coil current`);
  check('coil currents raise the ceiling above the mover-only floor',
    so.fullScale > so0.fullScale, `${(so.fullScale * 1000).toFixed(1)} vs ${(so0.fullScale * 1000).toFixed(1)} mT`);
}

console.log('\n=== pose observability: aliasing is real, 3-axis rides it out ===');
{
  const common = {
    gridHalf: 0.048, zBot: -stator.thickness, gap: 0.0015,
    travelHalf: 0.024, tiltMax: 0.05,
  };
  const all = poseObservability(tr, { ...common, spacing: tcfg.pitch * 0.9, axis: 'all' });
  check('3-axis grid at 0.9 lambda: every pose estimable',
    all.fracEstimable >= 0.999, `${(all.fracEstimable * 100).toFixed(1)}% of ${all.nPose} poses`);
  // Spacing at exactly the magnet pitch aliases: the single-axis grid loses
  // poses. This is the design rule ("never a simple fraction of the pitch")
  // stated as a failure the sweep must actually produce.
  const bzAliased = poseObservability(tr, { ...common, spacing: tcfg.pitch, axis: 'bz' });
  check('single-axis Bz at 1.0 lambda spacing aliases into lost poses',
    bzAliased.fracEstimable < 0.999,
    `${(bzAliased.fracEstimable * 100).toFixed(1)}% estimable, worstObs ${bzAliased.worstObs.toExponential(1)}`);
}

console.log('\n=== sensorLayout: the recommendation is self-consistent ===');
{
  const L = sensorLayout(stator, tr, { gap: 0.0015, maxTilt: 0.06 });
  check('a recommendation exists', L.available === true);
  check('recommended spacing avoids pitch and pitch/2 (the aliasing rule)',
    Math.abs(L.frac - 1.0) > 0.01 && Math.abs(L.frac - 0.5) > 0.01, `${L.frac} lambda`);
  check('grid count matches the recommended spacing over the stator',
    L.nGrid === Math.pow(Math.floor((2 * 0.048) / L.spacing) + 1, 2),
    `${L.nGrid} sensors at ${(L.spacing * 1000).toFixed(1)} mm`);
  check('the pick clears the comfort margin (not flagged marginal)', !L.marginal);
}

console.log('\n=== placement -> observability, the loop closed ===');
{
  // The fit search nudges sensors off their ideal grid for manufacturability;
  // a placement is only as good as the observability at the points actually
  // placed. Feed the as-placed positions straight back through the sweep.
  const { backsideFit } = await import('../src/kicad.js');
  const cfg = { stator: { ...stator.cfg } };
  const fit = backsideFit(cfg, { stator, sensorSpacing: 0.0216 });
  // Outline containment can honestly block a grid point hard against the
  // castellated rim (off the board is not a place). What matters is that the
  // sensors that DID place keep every pose estimable -- the as-placed sweep
  // below is the real gate; this one just bounds the attrition to the rim.
  check('the fit places the sensor grid, near-full', fit.sensors && fit.sensors.placed >= fit.sensors.wanted - 1,
    fit.sensors ? `${fit.sensors.placed}/${fit.sensors.wanted} (${fit.sensors.failed} rim-blocked, ${fit.sensors.offBoard} off-board)` : 'no sensors');
  const placed = fit.sensors.list.map((s) => [s.atMm[0] / 1000, s.atMm[1] / 1000]);
  const ap = poseObservability(tr, {
    sensors: placed, zBot: -stator.thickness, gap: 0.0015,
    travelHalf: 0.024, tiltMax: 0.05, axis: 'all',
  });
  check('explicit-position sweep uses exactly the placed sensors', ap.nSensors === placed.length);
  check('every pose stays estimable at the AS-PLACED positions',
    ap.fracEstimable >= 0.999, `${(ap.fracEstimable * 100).toFixed(1)}% of ${ap.nPose} poses, worstObs ${ap.worstObs.toFixed(4)}`);
  check('the nudges did not gut the conditioning',
    ap.worstObs > 0.03, `worstObs ${ap.worstObs.toFixed(4)} (ideal-grid ballpark 0.05)`);
}

console.log('\n=== yaw isotropy is the LATTICE, not the drive ===');
{
  // The spin sweeps first looked like an argument for per-coil drive: grouped
  // square-grid presets spiked ~20x in hover power mid-rotation. Wrong
  // attribution -- the INDEPENDENT square grid spikes almost as hard (x16 at
  // 45 deg), because the square coil lattice itself goes degenerate against
  // the rotated checkerboard. The honeycomb is yaw-isotropic with EITHER
  // drive. Pin both halves so neither claim can quietly rot.
  const { analysePose } = await import('../src/physics.js');
  const { quat } = await import('../src/math.js');
  const sq = makeStator({
    coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.096,
    windingHeight: 0.0016, wireDiameter: 0.0005, pcbLayers: 12,
    pcbTraceWidth: 0.000103, pcbCopperThickness: 35e-6,
    ringsPerCoil: 2, segmentsPerSide: 3,
  });
  const sweep = (st, mode) => {
    let p0 = 0, worst = 0;
    for (const deg of [0, 45, 75]) {
      const h = (deg * Math.PI / 180) / 2;
      const a = analysePose(st, tr, [0.002, 0.0012, 0.0015], [Math.cos(h), 0, 0, Math.sin(h)], 4, mode);
      const p = a.hoverSaturated <= 1e-6 ? a.hoverPower : Infinity;
      if (deg === 0) p0 = p;
      worst = Math.max(worst, p);
    }
    return worst / p0;
  };
  const hexR3 = sweep(stator, 'r3'), hexInd = sweep(stator, 'independent');
  const sqR3 = sweep(sq, 'r3'), sqInd = sweep(sq, 'independent');
  check('the honeycomb spins nearly free even GROUPED (r3 within 1.5x of level)',
    hexR3 < 1.5, `x${hexR3.toFixed(2)} worst-over-yaw`);
  check('independent drive on the honeycomb is no better than ~20% over grouped',
    hexR3 / hexInd < 1.25, `r3 x${hexR3.toFixed(2)} vs independent x${hexInd.toFixed(2)}`);
  check('the square grid pays heavily at 45 deg REGARDLESS of drive',
    sqR3 > 5 && sqInd > 5, `r3 x${sqR3.toFixed(1)}, independent x${sqInd.toFixed(1)}`);
}

console.log('\n=== liftVsGap: the exponential wall has the right sign ===');
{
  const gaps = [0.001, 0.002, 0.004];
  const out = liftVsGap(stator, tr, 1.0, gaps);
  const lifts = out.lift.map((p) => p[1]);
  check('lift falls monotonically as the gap opens',
    lifts[0] > lifts[1] && lifts[1] > lifts[2],
    lifts.map((v) => v.toFixed(2)).join(' > '));
  check('hover power rises as the gap opens',
    out.power[2][1] > out.power[0][1],
    `${out.power[0][1].toFixed(2)} -> ${out.power[2][1].toFixed(2)} W`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall analysis checks pass');
process.exit(fails ? 1 : 0);
