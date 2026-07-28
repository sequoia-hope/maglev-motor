// Pre-route the connections that do not need searching for.
//
// Most of this board's netlist is LOCAL and its geometry is already known: the
// bridge's two outputs go to the two coil terminals in the same cell, its two
// inputs go to the register that drives that cell, and its supply pins go to
// the decoupling cap beside it. Those are short, they are the same shape in
// every one of 168 cells, and handing them to a maze router is asking it to
// rediscover the lattice 500 times.
//
// So they are laid here, deterministically, and given to freerouting as FIXED
// wiring. What is left for the autorouter is the part it is actually good at:
// the global spine -- power, clocks, the shift chain and the sensor buses --
// crossing a board whose local traffic is already out of the way.
//
// This is not a maze router. It tries a handful of obvious paths (straight, two
// L-bends, two 45-degree doglegs), checks each against every pad, via land and
// already-laid trace at a full fab clearance, and takes the first that is
// clear. Anything it cannot place it simply leaves for freerouting.

const EPS = 1e-9;

/** Distance from point p to segment ab. */
function ptSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L > EPS ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/** Distance between segments ab and cd (0 if they cross). */
function segSeg(a, b, c, d) {
  const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
  const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}

/** Distance from segment ab to an oriented rectangle (cx,cy,w,h,ang). */
function segRect(a, b, r) {
  const c = Math.cos(-r.ang), s = Math.sin(-r.ang);
  const to = (p) => {
    const dx = p[0] - r.cx, dy = p[1] - r.cy;
    return [dx * c - dy * s, dx * s + dy * c];
  };
  const A = to(a), B = to(b);
  const hw = r.w / 2, hh = r.h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  // Inside counts as zero.
  for (const P of [A, B]) if (Math.abs(P[0]) <= hw && Math.abs(P[1]) <= hh) return 0;
  let m = Infinity;
  for (let i = 0; i < 4; i++) m = Math.min(m, segSeg(A, B, corners[i], corners[(i + 1) % 4]));
  return m;
}

/** The obstacle set a trace must clear: every pad and via land that is not on
 *  its own net, plus every trace already laid on another net. */
export function makeField(board, netOf) {
  const pads = [], vias = [], traces = [];
  for (const fp of board.fps) {
    for (const pd of fp.pads) {
      pads.push({
        cx: fp.x + pd.dx, cy: fp.y + pd.dy, w: pd.w, h: pd.h,
        ang: ((fp.rot + pd.ang) * Math.PI) / 180,
        net: netOf(fp.ref, pd.name, pd.netName), layer: pd.layer,
      });
    }
  }
  for (const v of board.vias) vias.push({ x: v.x, y: v.y, r: v.size / 2, net: v.net });
  return { pads, vias, traces };
}

/** Is this polyline clear of everything not on `net`, by `clr`, on `layer`? */
function clear(pts, net, coilNet, field, clr, width, layer) {
  const half = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) continue;
    for (const p of field.pads) {
      if (p.layer !== layer || p.net === net) continue;
      if (segRect(a, b, p) < half + clr) return false;
    }
    for (const v of field.vias) {
      // Via lands are on every layer (plated through holes). A via belonging to
      // this coil is the terminal the trace is heading for -- allowed.
      if (coilNet != null && v.net === coilNet) continue;
      if (ptSeg([v.x, v.y], a, b) < half + v.r + clr) return false;
    }
    for (const t of field.traces) {
      if (t.net === net || t.layer !== layer) continue;
      for (let k = 0; k + 1 < t.pts.length; k++) {
        if (segSeg(a, b, t.pts[k], t.pts[k + 1]) < width / 2 + t.width / 2 + clr) return false;
      }
    }
  }
  return true;
}

/** Candidate paths from A to B, cheapest first: straight, then the two L-bends
 *  and the two 45-degree doglegs, then a sweep of Z-shapes that step sideways
 *  around whatever is in the way. Short and blunt on purpose -- this is not a
 *  maze router, it is a way of laying the paths that are obvious so that the
 *  maze router only sees the ones that are not. Anything still blocked after
 *  ~50 tries is left for freerouting, which is better at it. */
function candidates(A, B) {
  const [ax, ay] = A, [bx, by] = B;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const s = Math.sign(dx) || 1, t = Math.sign(dy) || 1;
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  const out = [
    [A, B],
    [A, [ax + s * m, ay + t * m], B],
    [A, [bx - s * m, by - t * m], B],
    [A, [bx, ay], B],
    [A, [ax, by], B],
  ];
  // Sidestep: leave A perpendicular by `off`, run parallel, come back at B.
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  for (const off of [0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2, 3.0, -3.0]) {
    for (const f of [0.2, 0.35, 0.5]) {
      const p1 = [ax + ux * len * f + nx * off, ay + uy * len * f + ny * off];
      const p2 = [ax + ux * len * (1 - f) + nx * off, ay + uy * len * (1 - f) + ny * off];
      out.push([A, p1, p2, B]);
    }
  }
  return out;
}

/** Lay `conns` (each {net, coilNet, a, b, layer}) and return the traces laid. */
export function prewire(conns, field, { clearance, width }) {
  const laid = [];
  let done = 0;
  for (const c of conns) {
    let got = null;
    for (const pts of candidates(c.a, c.b)) {
      if (clear(pts, c.net, c.coilNet, field, clearance, width, c.layer)) { got = pts; break; }
    }
    if (!got) continue;
    const tr = { net: c.net, pts: got, width, layer: c.layer };
    field.traces.push(tr);
    laid.push(tr);
    done++;
  }
  return { laid, done, tried: conns.length };
}
