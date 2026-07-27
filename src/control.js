// 6-DOF flight control. The plant is a free rigid body (magnetic levitation has
// no passive stiffness -- Earnshaw's theorem guarantees it can't), so the
// controller is a straightforward double-integrator PID per axis with gravity
// feedforward. Gains are derived from a requested closed-loop bandwidth rather
// than typed in, so changing the platen mass doesn't silently retune the loop.

import { quat, clamp } from './math.js';

export function makeController(cfg) {
  return {
    cfg,
    ei: [0, 0, 0],
    ea: [0, 0, 0],
    last: null,
  };
}

/** Gains for a critically-damped second-order response at bandwidth wn.
 *  Returned in acceleration units, so they multiply mass/inertia at the end. */
function gains(wn, zeta, ki) {
  return { kp: wn * wn, kd: 2 * zeta * wn, ki: ki * wn * wn * wn };
}

export const TRAJECTORIES = {
  hover: {
    label: 'Hover',
    at: (t, p) => ({ r: [0, 0, p.gap], v: [0, 0, 0], a: [0, 0, 0], rpy: [0, 0, 0] }),
  },
  step: {
    label: 'Step (x)',
    at: (t, p) => {
      const period = 2 / p.speed;
      const on = Math.floor(t / period) % 2 === 1;
      return { r: [on ? p.amplitude : 0, 0, p.gap], v: [0, 0, 0], rpy: [0, 0, 0] };
    },
  },
  circle: {
    label: 'Circle (x-y)',
    at: (t, p) => {
      const w = p.speed;
      return {
        r: [p.amplitude * Math.cos(w * t), p.amplitude * Math.sin(w * t), p.gap],
        v: [-p.amplitude * w * Math.sin(w * t), p.amplitude * w * Math.cos(w * t), 0],
        a: [-p.amplitude * w * w * Math.cos(w * t), -p.amplitude * w * w * Math.sin(w * t), 0],
        rpy: [0, 0, 0],
      };
    },
  },
  raster: {
    // Continuous CLOSED serpentine: sweep, step over, sweep back, and finally
    // return to the start. A path that teleports at the cycle boundary would
    // just be measuring the controller against an impossible command.
    label: 'Raster scan',
    at: (t, p) => {
      const A = p.amplitude, rows = 5;
      const legT = 1 / p.speed, stepT = legT * 0.35;
      const y = (r) => -A + (2 * A * r) / (rows - 1);
      const segs = [];
      for (let r = 0; r < rows; r++) {
        const dir = r % 2 === 0 ? 1 : -1;
        segs.push({ from: [-dir * A, y(r)], to: [dir * A, y(r)], T: legT });
        if (r < rows - 1) segs.push({ from: [dir * A, y(r)], to: [dir * A, y(r + 1)], T: stepT });
      }
      const last = segs[segs.length - 1].to;
      segs.push({ from: last, to: [-A, y(0)], T: legT * 1.2 }); // return home
      const cycle = segs.reduce((a2, s2) => a2 + s2.T, 0);
      let u = t % cycle;
      for (const s2 of segs) {
        if (u < s2.T) {
          const f = u / s2.T;
          const sm = f * f * (3 - 2 * f);          // smoothstep: C1 at both ends
          const dsm = (6 * f * (1 - f)) / s2.T;
          const ddsm = (6 - 12 * f) / (s2.T * s2.T);
          const dx = s2.to[0] - s2.from[0], dy = s2.to[1] - s2.from[1];
          return {
            r: [s2.from[0] + dx * sm, s2.from[1] + dy * sm, p.gap],
            v: [dx * dsm, dy * dsm, 0],
            a: [dx * ddsm, dy * ddsm, 0],
            rpy: [0, 0, 0],
          };
        }
        u -= s2.T;
      }
      return { r: [-A, y(0), p.gap], v: [0, 0, 0], rpy: [0, 0, 0] };
    },
  },
  tilt: {
    label: 'Tilt sweep',
    at: (t, p) => ({
      r: [0, 0, p.gap],
      v: [0, 0, 0],
      rpy: [p.tiltAmp * Math.sin(p.speed * t), p.tiltAmp * Math.sin(p.speed * t * 0.7), 0],
    }),
  },
  spin: {
    // CONTINUOUS yaw rotation while hovering: the magnet array turns without
    // bound over the coil grid, so the allocator must re-commutate through
    // every relative angle -- including the 45 deg worst case a fixed-phase
    // drive cannot reach. Yaw is the one axis with no tilt clamp and no
    // wrap-around cost (quat.errorVec always steers the short way), so the
    // target angle simply grows; `omega` feeds the rate forward, without which
    // a pure PD lags a constant-rate spin by exactly kd*w/kp.
    label: 'Yaw spin',
    at: (t, p) => ({
      r: [0, 0, p.gap],
      v: [0, 0, 0],
      rpy: [0, 0, p.speed * t],
      omega: [0, 0, p.speed],
    }),
  },
  zsweep: {
    label: 'Air-gap sweep',
    at: (t, p) => ({
      r: [0, 0, p.gap + p.gap * 0.5 * Math.sin(p.speed * t)],
      v: [0, 0, p.gap * 0.5 * p.speed * Math.cos(p.speed * t)],
      a: [0, 0, -p.gap * 0.5 * p.speed * p.speed * Math.sin(p.speed * t)],
      rpy: [0, 0, 0],
    }),
  },
};

/** One control update. Returns the desired wrench plus the tracking error, in
 *  a form the scope can plot directly. */
export function control(ctrl, state, tr, dt, target) {
  const { bwPos, bwAtt, zeta, kiPos, kiAtt, maxTilt } = ctrl.cfg;
  const gp = gains(bwPos, zeta, kiPos);
  const ga = gains(bwAtt, zeta, kiAtt);

  const ep = [
    target.r[0] - state.r[0],
    target.r[1] - state.r[1],
    target.r[2] - state.r[2],
  ];
  const ev = [
    (target.v?.[0] ?? 0) - state.v[0],
    (target.v?.[1] ?? 0) - state.v[1],
    (target.v?.[2] ?? 0) - state.v[2],
  ];
  const qDes = quat.fromEuler(
    clamp(target.rpy?.[0] ?? 0, -maxTilt, maxTilt),
    clamp(target.rpy?.[1] ?? 0, -maxTilt, maxTilt),
    target.rpy?.[2] ?? 0,
  );
  const ea = quat.errorVec(state.q, qDes);

  // Anti-windup, two mechanisms. First, the integrator is clamped in terms of
  // the ACCELERATION it is allowed to command, not raw position error -- a
  // fixed error clamp means something wildly different at bandwidth 5 vs 50.
  // Second, integration is suspended while the allocator is saturated: on a
  // machine with modest lateral authority, a fast trajectory otherwise winds
  // the integrator to its limit and then flings the platen off the stator.
  const accLimP = 1.5;  // m/s^2 of integral authority
  const accLimA = 6;    // rad/s^2
  const iLimP = gp.ki > 1e-9 ? accLimP / gp.ki : 0;
  const iLimA = ga.ki > 1e-9 ? accLimA / ga.ki : 0;
  const saturated = (ctrl.sat ?? 0) > 0.02;
  for (let a = 0; a < 3; a++) {
    if (saturated) {
      ctrl.ei[a] *= 0.99; ctrl.ea[a] *= 0.99;
    } else {
      ctrl.ei[a] = clamp(ctrl.ei[a] + ep[a] * dt, -iLimP, iLimP);
      ctrl.ea[a] = clamp(ctrl.ea[a] + ea[a] * dt, -iLimA, iLimA);
    }
  }

  const m = tr.mass;
  const I = tr.inertia;
  const g = 9.80665;

  // Acceleration feedforward. Without it a PD loop lags any accelerating
  // trajectory by exactly a_cmd/kp -- millimetres on a slow machine, which
  // looks like a controller bug but is just the missing term.
  const af = target.a ?? [0, 0, 0];
  // Angular-rate feedforward, the attitude twin of the acceleration term: a
  // trajectory that ROTATES steadily (the yaw spin) would otherwise drag a
  // constant error of kd*omega/kp behind it -- degrees of lag that look like
  // a tuning problem but are just the missing reference rate.
  const om = target.omega ?? [0, 0, 0];
  const w = [
    m * (gp.kp * ep[0] + gp.kd * ev[0] + gp.ki * ctrl.ei[0] + af[0]),
    m * (gp.kp * ep[1] + gp.kd * ev[1] + gp.ki * ctrl.ei[1] + af[1]),
    m * (gp.kp * ep[2] + gp.kd * ev[2] + gp.ki * ctrl.ei[2] + af[2]) + m * g, // gravity FF
    I[0] * (ga.kp * ea[0] + ga.kd * (om[0] - state.w[0]) + ga.ki * ctrl.ea[0]),
    I[1] * (ga.kp * ea[1] + ga.kd * (om[1] - state.w[1]) + ga.ki * ctrl.ea[1]),
    I[2] * (ga.kp * ea[2] + ga.kd * (om[2] - state.w[2]) + ga.ki * ctrl.ea[2]),
  ];

  ctrl.last = { ep, ea, w };
  return { w, ep, ea };
}

// --- disturbances -----------------------------------------------------------

export function makeDisturbance() {
  return { impulse: null, constant: [0, 0, 0], noise: 0 };
}

export function applyDisturbance(dist, wrench, dt, tr) {
  const out = wrench.slice();
  out[0] += dist.constant[0];
  out[1] += dist.constant[1];
  out[2] += dist.constant[2];
  if (dist.impulse) {
    const remaining = dist.impulse.duration;
    if (remaining > 0) {
      out[0] += dist.impulse.f[0];
      out[1] += dist.impulse.f[1];
      out[2] += dist.impulse.f[2];
      out[3] += dist.impulse.t[0];
      out[4] += dist.impulse.t[1];
      out[5] += dist.impulse.t[2];
      dist.impulse.duration -= dt;
    } else {
      dist.impulse = null;
    }
  }
  if (dist.noise > 0) {
    const s = dist.noise * tr.mass * 9.80665;
    for (let a = 0; a < 3; a++) out[a] += (Math.random() - 0.5) * 2 * s;
  }
  return out;
}

export function kick(dist, tr, strengthG = 0.5, durationMs = 20) {
  const f = tr.mass * 9.80665 * strengthG;
  const ang = Math.random() * Math.PI * 2;
  dist.impulse = {
    f: [f * Math.cos(ang), f * Math.sin(ang), f * 0.3],
    t: [0, 0, 0],
    duration: durationMs / 1000,
  };
}
