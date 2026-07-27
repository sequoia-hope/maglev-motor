import { makeTranslator } from '../src/halbach.js';
import { makeStator } from '../src/coils.js';
import { analysePose, buildWrench, allocatePrioritised, copperLoss, makeState, step } from '../src/physics.js';
import { makeController, control, TRAJECTORIES, makeDisturbance, applyDisturbance } from '../src/control.js';
import { quat } from '../src/math.js';
import { groupWrench } from '../src/physics.js';
import { buildGrouping } from '../src/grouping.js';
import { stackUp, mechDefaultsFor, DEFAULT_MECH } from '../src/mechanical.js';
import { readFileSync } from 'fs';

// Pull the presets straight out of app.js so the test exercises what ships.
const src = readFileSync('../src/app.js', 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const QUALITY = { fast: { segmentsPerSide: 2, ringsPerCoil: 1, maxOrder: 2, controlHz: 400 },
  balanced: { segmentsPerSide: 3, ringsPerCoil: 2, maxOrder: 3, controlHz: 600 },
  accurate: { segmentsPerSide: 5, ringsPerCoil: 3, maxOrder: 4, controlHz: 1000 } };

let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fails++; };

for (const [key, preset] of Object.entries(PRESETS)) {
  const cfg = JSON.parse(JSON.stringify(preset.cfg));
  const q = QUALITY[cfg.sim.quality];
  console.log(`\n=== ${key}: ${preset.label} ===`);

  // Mirror the app: the mechanical stack supplies the platen mass.
  const stack = stackUp(cfg, cfg.mech ?? mechDefaultsFor(cfg, DEFAULT_MECH));
  const tr = makeTranslator({ ...cfg.translator,
    platenMass: cfg.translator.platenMass || stack.platenMass,
    gap: cfg.sim.gap, maxOrder: q.maxOrder });
  const stator = makeStator({ ...cfg.stator, ringsPerCoil: q.ringsPerCoil, segmentsPerSide: q.segmentsPerSide });
  const a = analysePose(stator, tr, [0, 0, cfg.sim.gap], quat.identity(), cfg.sim.iMax, cfg.sim.grouping);
  console.log(`  mass ${(tr.mass * 1000).toFixed(0)} g · gap floor ${(stack.gapFloor * 1000).toFixed(2)}mm · ${stator.coils.length} coils (${a.activeCoils} active) · ${a.amplifiers} amplifiers [${cfg.sim.grouping}] · peak B ${tr.peakGapField.toFixed(3)} T`);
  console.log(`  lift ${a.liftMargin.toFixed(2)}x · accel ${(a.maxAccel / 9.81).toFixed(2)} g · hover ${a.hoverPower.toFixed(2)} W · cond ${a.conditionNumber.toFixed(1)} · sigmaMin ${a.sigmaMin.toExponential(2)}`);
  check('can hover', a.liftMargin > 1, `${a.liftMargin.toFixed(2)}x`);
  check('air gap clears the mechanical tolerance stack', cfg.sim.gap >= stack.gapFloor,
    `${(cfg.sim.gap * 1000).toFixed(2)} mm vs floor ${(stack.gapFloor * 1000).toFixed(2)} mm`);
  check('has 6-DOF authority', a.sigmaMin > 1e-4 * a.sigma[0], `sigmaMin/sigmaMax = ${(a.sigmaMin / a.sigma[0]).toExponential(2)}`);

  // WORKSPACE CHECK. A single centred pose is the weakest possible test: it is
  // a symmetry point, and a stator can have periodic dead bands a few mm away
  // that the platen falls straight through. Sweep the reachable area and demand
  // it can hover EVERYWHERE.
  let worstLift = Infinity, worstAt = null;
  const reach = Math.max(0.005,
    Math.min(0.03, (cfg.stator.statorSize - cfg.translator.platenSize) / 2 - cfg.translator.pitch / 2));
  for (let iy = 0; iy <= 6; iy++) {
    for (let ix = 0; ix <= 6; ix++) {
      const x = -reach + (2 * reach * ix) / 6, y = -reach + (2 * reach * iy) / 6;
      const m = analysePose(stator, tr, [x, y, cfg.sim.gap], quat.identity(), cfg.sim.iMax, cfg.sim.grouping).liftMargin;
      if (m < worstLift) { worstLift = m; worstAt = [x, y]; }
    }
  }
  console.log(`  worst-case lift over +/-${(reach * 1000).toFixed(0)}mm workspace: ${worstLift.toFixed(2)}x at (${(worstAt[0] * 1000).toFixed(0)}, ${(worstAt[1] * 1000).toFixed(0)}) mm`);
  check('can hover everywhere in the workspace', worstLift > 1.2, `worst ${worstLift.toFixed(2)}x`);

  for (const trajName of ['hover', 'circle', 'raster', 'spin']) {
    const state = makeState(tr, cfg.sim.gap);
    const ctrl = makeController(cfg.sim);
    const dist = makeDisturbance();
    const dt = 1 / q.controlHz;
    const tp = { gap: cfg.sim.gap, amplitude: 0.015, speed: 2, tiltAmp: 0.02 };
    // Start 20% below the setpoint so the loop has to actually catch it.
    state.r[2] = cfg.sim.gap * 0.8;
    let worst = 0, worstLate = 0, peakI = 0, pw = 0;
    // Spin bookkeeping: unwrapped yaw actually travelled, and the worst
    // attitude error once settled -- a spin that quietly slips turns or drags
    // a fat lag would still pass the position checks.
    let yawGone = 0, prevYaw = 0, attLate = 0;
    const yawOf = (qq) => Math.atan2(2 * (qq[0] * qq[3] + qq[1] * qq[2]), 1 - 2 * (qq[2] * qq[2] + qq[3] * qq[3]));
    const T = 4;
    for (let i = 0; i < T / dt; i++) {
      const target = TRAJECTORIES[trajName].at(state.t, tp);
      const { w, ea } = control(ctrl, state, tr, dt, target);
      const bw = buildWrench(stator, tr, state.r, state.q);
      const Wm = cfg.sim.grouping === 'independent' ? bw
        : groupWrench(bw, buildGrouping(stator, tr, state.r, state.q, cfg.sim.grouping, bw.idx));
      const wLift = [0, 0, tr.mass * 9.80665, 0, 0, 0];
      const alloc = allocatePrioritised(Wm, wLift, w.map((v, i) => v - wLift[i]), cfg.sim.iMax);
      ctrl.sat = alloc.saturated;
      step(state, tr, applyDisturbance(dist, alloc.achieved, dt, tr), dt);
      const e = Math.hypot(state.r[0] - target.r[0], state.r[1] - target.r[1], state.r[2] - target.r[2]);
      worst = Math.max(worst, e);
      if (state.t > 2) worstLate = Math.max(worstLate, e);
      if (trajName === 'spin') {
        const y = yawOf(state.q);
        let dy = y - prevYaw;
        if (dy > Math.PI) dy -= 2 * Math.PI; else if (dy < -Math.PI) dy += 2 * Math.PI;
        yawGone += dy; prevYaw = y;
        if (state.t > 2) attLate = Math.max(attLate, Math.hypot(ea[0], ea[1], ea[2]));
      }
      for (let j = 0; j < alloc.i.length; j++) peakI = Math.max(peakI, Math.abs(alloc.i[j]));
      pw = copperLoss(stator, Wm, alloc.i);
      if (!isFinite(state.r[2])) break;
    }
    const tilt = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (state.q[1] ** 2 + state.q[2] ** 2))));
    console.log(`  ${trajName.padEnd(7)} settled err ${(worstLate * 1e6).toFixed(0).padStart(6)} um · peak transient ${(worst * 1000).toFixed(2)} mm · peak I ${peakI.toFixed(2)} A · P ${pw.toFixed(1)} W · tilt ${(tilt * 1000).toFixed(2)} mrad${trajName === 'spin' ? ` · yaw ${yawGone.toFixed(1)} rad, att lag ${(attLate * 1e3).toFixed(1)} mrad` : ''}`);
    check(`${trajName}: stayed airborne`, !state.landed && isFinite(state.r[2]), `z = ${(state.r[2] * 1000).toFixed(2)} mm`);
    check(`${trajName}: settled`, worstLate < 5e-4, `${(worstLate * 1e6).toFixed(0)} um`);
    if (trajName === 'spin') {
      // The platen must actually have gone round -- continuously, through the
      // 45 deg relative angles a fixed-phase drive cannot commutate.
      check('spin: full continuous rotation', yawGone > tp.speed * T * 0.95,
        `${yawGone.toFixed(1)} of ${(tp.speed * T).toFixed(0)} rad`);
      check('spin: tracked without slipping a turn', attLate < 0.05,
        `worst attitude error ${(attLate * 1e3).toFixed(1)} mrad`);
    }
  }
}

console.log(`\n${fails === 0 ? 'ALL PRESETS FLY' : fails + ' FAILURE(S)'}`);
process.exit(fails ? 1 : 0);
