// Dependency-free 3-D view: perspective projection onto a 2-D canvas with
// painter's-algorithm depth sorting. Everything drawn is a convex quad, so
// sorting by centroid depth is exact enough and costs nothing.

import { quat } from './math.js';
import { eachCell, cellIsEmpty } from './halbach.js';

export const PALETTE = {
  light: {
    surface: '#fcfcfb', plane: '#f9f9f7', ink: '#0b0b0b', ink2: '#52514e',
    muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
    s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100',
    s5: '#e87ba4', s6: '#008300', s7: '#4a3aa7', s8: '#e34948',
    neutral: '#f0efec',
    good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b',
  },
  dark: {
    surface: '#1a1a19', plane: '#0d0d0d', ink: '#ffffff', ink2: '#c3c2b7',
    muted: '#898781', grid: '#2c2c2a', axis: '#383835',
    s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500',
    s5: '#d55181', s6: '#008300', s7: '#9085e9', s8: '#e66767',
    neutral: '#383835',
    good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b',
  },
};

export function theme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return PALETTE.dark;
  if (attr === 'light') return PALETTE.light;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? PALETTE.dark : PALETTE.light;
}

// Diverging blue<->red through a neutral midpoint: signed current.
export function divergingColor(t, pal) {
  const u = Math.max(-1, Math.min(1, t));
  const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
  const blue = [42, 120, 214], red = [208, 59, 59];
  const mid = pal === PALETTE.dark ? [56, 56, 53] : [240, 239, 236];
  const c = u < 0 ? mix(mid, blue, -u) : mix(mid, red, u);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Sequential single-hue blue ramp: unsigned magnitude.
export function sequentialColor(t) {
  const steps = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const u = Math.max(0, Math.min(0.999, t)) * (steps.length - 1);
  const i = Math.floor(u), f = u - i;
  const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const a = hex(steps[i]), b = hex(steps[Math.min(i + 1, steps.length - 1)]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

export function makeCamera() {
  return { az: -0.7, el: 0.55, dist: 0.42, target: [0, 0, 0.01], fov: 1.0, userZoomed: false };
}

/** Frame the machine. Respects a manual zoom once the user has scrolled, so
 *  tweaking a slider doesn't yank the view back. */
export function fitCamera(cam, statorSize, platenSize, gap) {
  cam.target = [0, 0, gap * 0.5];
  if (cam.userZoomed) return;
  cam.dist = Math.max(statorSize * 1.05, platenSize * 2.4);
}

/** Standard orbit look-at basis. Rebuilt once per frame, then every point is
 *  three dot products and a divide. */
function cameraBasis(cam, w, h) {
  const ce = Math.cos(cam.el), se = Math.sin(cam.el);
  const ca = Math.cos(cam.az), sa = Math.sin(cam.az);
  const eye = [
    cam.target[0] + cam.dist * ce * ca,
    cam.target[1] + cam.dist * ce * sa,
    cam.target[2] + cam.dist * se,
  ];
  const fwd = [-ce * ca, -ce * sa, -se];
  // right = fwd x worldUp, normalised
  let right = [fwd[1] * 1 - fwd[2] * 0, fwd[2] * 0 - fwd[0] * 1, 0];
  const rl = Math.hypot(right[0], right[1], right[2]) || 1;
  right = [right[0] / rl, right[1] / rl, right[2] / rl];
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return {
    eye, fwd, right, up,
    f: (Math.min(w, h) * 0.5) / Math.tan(cam.fov / 2),
    cx: w / 2, cy: h / 2,
  };
}

export { cameraBasis, project, magnetRGB, divergingRGB };

function project(B, p) {
  const rx = p[0] - B.eye[0], ry = p[1] - B.eye[1], rz = p[2] - B.eye[2];
  const zc = rx * B.fwd[0] + ry * B.fwd[1] + rz * B.fwd[2];
  if (zc < 1e-4) return null; // behind the camera
  const xc = rx * B.right[0] + ry * B.right[1] + rz * B.right[2];
  const yc = rx * B.up[0] + ry * B.up[1] + rz * B.up[2];
  return { x: B.cx + (B.f * xc) / zc, y: B.cy - (B.f * yc) / zc, d: zc };
}

function quadPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** Magnetisation direction -> colour. In-plane direction picks the hue pair,
 *  vertical picks blue (+z) / red (-z), matching the diverging convention used
 *  everywhere else in the app. */
function magnetColor(mx, my, mz, Br, pal) {
  const vert = mz / Br;
  if (Math.abs(vert) > 0.6) return divergingColor(vert, pal);
  const ang = Math.atan2(my, mx);
  const l = pal === PALETTE.dark ? 62 : 52;
  return `hsl(${((ang * 180) / Math.PI + 360) % 360}, 45%, ${l}%)`;
}

/** Solid-geometry renderer. Every part is drawn as an extruded box with its
 *  real thickness -- magnet stack, winding build height, platen plate -- because
 *  those thicknesses ARE the design, and a flat quad hides all of them.
 *
 *  Two viewing aids, both of which distort the picture on purpose and are
 *  labelled as such in the UI:
 *    - a section plane that hides everything past a cut, so you can see the air
 *      gap and the layer stack in cross-section;
 *    - a vertical exaggeration, because a 1.5 mm air gap under a 72 mm platen
 *      is otherwise a sub-pixel sliver.
 */

const LIGHT = (() => {
  const v = [0.35, -0.55, 0.76];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

// Corner order: 0-3 bottom face CCW seen from above, 4-7 the matching top.
const BOX_FACES = [
  [4, 5, 6, 7], [3, 2, 1, 0],
  [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7],
];

function hslToRgb(hDeg, s, l) {
  const h = ((hDeg % 360) + 360) / 360 % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function divergingRGB(t, pal) {
  const u = Math.max(-1, Math.min(1, t));
  const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
  const blue = [42, 120, 214], red = [208, 59, 59];
  const mid = pal === PALETTE.dark ? [56, 56, 53] : [240, 239, 236];
  return u < 0 ? mix(mid, blue, -u) : mix(mid, red, u);
}

function magnetRGB(mx, my, mz, Br, pal) {
  const vert = mz / Br;
  if (Math.abs(vert) > 0.6) return divergingRGB(vert, pal);
  const ang = (Math.atan2(my, mx) * 180) / Math.PI;
  return hslToRgb(ang, 0.45, pal === PALETTE.dark ? 0.62 : 0.52);
}

/** Depth-sorted face buffer over a camera basis. Shared by the machine view and
 *  the exploded assembly view so both get identical shading, culling and
 *  vertical exaggeration -- an assembly drawing that lit its parts differently
 *  from the machine view would read as a different machine. */
export function makePainter(B, zs = 1) {
  const faces = [];
  const P = (p) => project(B, [p[0], p[1], p[2] * zs]);

  /** Push the visible faces of an axis-aligned-in-local-frame box.
   *  `corners` are eight world-space points: 0-3 bottom CCW from above, 4-7 top. */
  const pushBox = (corners, rgb, opts = {}) => {
    const pts = corners.map((c) => P(c));
    for (const f of BOX_FACES) {
      if (opts.skipBottom && f === BOX_FACES[1]) continue;
      const a = corners[f[0]], b = corners[f[1]], c = corners[f[2]];
      // Normal from the world corners, with z already exaggerated so shading
      // matches what is actually drawn.
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = (b[2] - a[2]) * zs;
      const vx = c[0] - b[0], vy = c[1] - b[1], vz = (c[2] - b[2]) * zs;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // Backface cull against the eye.
      const ex = a[0] - B.eye[0], ey = a[1] - B.eye[1], ez = a[2] * zs - B.eye[2];
      if (nx * ex + ny * ey + nz * ez > 0) continue;
      const q = f.map((i) => pts[i]);
      if (q.some((p) => !p)) continue;
      const lam = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const k = 0.52 + 0.48 * lam;
      faces.push({
        d: (q[0].d + q[2].d) / 2,
        pts: q,
        fill: `rgb(${Math.round(rgb[0] * k)},${Math.round(rgb[1] * k)},${Math.round(rgb[2] * k)})`,
        stroke: opts.stroke,
        alpha: opts.alpha,
      });
    }
  };

  const pushQuad = (corners, fill, opts = {}) => {
    const q = corners.map((c) => P(c));
    if (q.some((p) => !p)) return;
    faces.push({ d: (q[0].d + q[2].d) / 2 + (opts.bias ?? 0), pts: q, fill, stroke: opts.stroke, alpha: opts.alpha });
  };

  const paint = (ctx) => {
    faces.sort((a, b) => b.d - a.d);
    for (const f of faces) {
      quadPath(ctx, f.pts);
      if (f.alpha !== undefined) ctx.globalAlpha = f.alpha;
      ctx.fillStyle = f.fill;
      ctx.fill();
      if (f.stroke) { ctx.strokeStyle = f.stroke; ctx.lineWidth = 0.6; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  };

  return { faces, P, pushBox, pushQuad, paint };
}

/** Set up a canvas for a device-pixel-ratio-correct 2-D draw and clear it. */
export function prepCanvas(canvas, pal) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pal.surface;
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

export function render(canvas, scene) {
  const pal = theme();
  const { ctx, w, h } = prepCanvas(canvas, pal);

  const { cam, stator, tr, state, currents, idxMap, target, trail } = scene;
  const zs = scene.zScale ?? 1;
  const sec = scene.section ?? { axis: 'none', frac: 0.5 };
  const B = cameraBasis(cam, w, h);
  const painter = makePainter(B, zs);
  const { faces, P, pushBox } = painter;

  // Section test on an element's centre. Simple hiding rather than true
  // clipping: the exposed side faces of what survives read as the cut.
  const cutAt = (() => {
    if (sec.axis === 'none') return null;
    const half = Math.max(tr.cfg.platenSize, 0.02) * 1.2;
    return -half + 2 * half * (sec.frac ?? 0.5);
  })();
  const sectioned = (x, y) => {
    if (cutAt === null) return false;
    return (sec.axis === 'x' ? x : y) > cutAt;
  };

  // --- stator coils --------------------------------------------------------
  let iPeak = 1e-9;
  if (currents) for (let j = 0; j < currents.length; j++) iPeak = Math.max(iPeak, Math.abs(currents[j]));
  const curOf = new Map();
  if (currents && idxMap) idxMap.forEach((ci, j) => curOf.set(ci, currents[j]));

  const ct = stator.thickness;
  const inactiveRGB = pal === PALETTE.dark ? [46, 46, 44] : [225, 224, 217];
  // Far-away coils are drawn flat: they carry no current and no information,
  // and a 625-coil stator at six faces each is not worth the frame time.
  const detailR = tr.footprintRadius * 2.2;

  stator.coils.forEach((c, ci) => {
    if (sectioned(c.x, c.y)) return;
    const hx = c.outer[0] / 2, hy = c.outer[1] / 2;
    const top = c.z + ct / 2, bot = c.z - ct / 2;
    const cur = curOf.get(ci) ?? 0;
    const active = curOf.has(ci);
    const rgb = active ? divergingRGB(cur / iPeak, pal) : inactiveRGB;
    const near = Math.abs(c.x - state.r[0]) < detailR && Math.abs(c.y - state.r[1]) < detailR;

    if (!near) {
      const q = [[c.x - hx, c.y - hy, top], [c.x + hx, c.y - hy, top],
        [c.x + hx, c.y + hy, top], [c.x - hx, c.y + hy, top]].map(P);
      if (q.some((p) => !p)) return;
      faces.push({ d: (q[0].d + q[2].d) / 2, pts: q, fill: `rgb(${rgb})` });
      return;
    }
    pushBox([
      [c.x - hx, c.y - hy, bot], [c.x + hx, c.y - hy, bot],
      [c.x + hx, c.y + hy, bot], [c.x - hx, c.y + hy, bot],
      [c.x - hx, c.y - hy, top], [c.x + hx, c.y - hy, top],
      [c.x + hx, c.y + hy, top], [c.x - hx, c.y + hy, top],
    ], rgb, { skipBottom: true, stroke: active ? pal.axis : null });

    // Winding window, drawn on the top face so the coil reads as a coil.
    const ix = c.inner[0] / 2, iy = c.inner[1] / 2;
    const q = [[c.x - ix, c.y - iy, top], [c.x + ix, c.y - iy, top],
      [c.x + ix, c.y + iy, top], [c.x - ix, c.y + iy, top]].map(P);
    if (!q.some((p) => !p)) {
      faces.push({
        d: (q[0].d + q[2].d) / 2 - 1e-7, pts: q,
        fill: pal === PALETTE.dark ? 'rgb(18,18,17)' : 'rgb(246,245,242)',
      });
    }
  });

  // --- translator: magnet cells, extruded to their real thickness ----------
  const R = quat.toMat3(state.q);
  const toWorld = (u, v, zz) => [
    state.r[0] + R[0] * u + R[1] * v + R[2] * zz,
    state.r[1] + R[3] * u + R[4] * v + R[5] * zz,
    state.r[2] + R[6] * u + R[7] * v + R[8] * zz,
  ];

  const tile = tr.tile;
  const cellW = tile.lx / tile.nx, cellH = tile.ly / tile.ny;
  const magT = tr.cfg.magnetThickness;

  eachCell(tile, tr.patches, (px, py, k, pt) => {
    // A pattern null is an empty pocket. Drawing a block there would show a
    // platen you cannot build and a magnet count you do not buy.
    if (cellIsEmpty(tile, k)) return;
    const pc = pt.cos, ps = pt.sin;
    const rgb = magnetRGB(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2], tile.Br, pal);

    const local = (a, b) => [pt.u + (px + a) * pc - (py + b) * ps,
      pt.v + (px + a) * ps + (py + b) * pc];
    const g = 0.06 * cellW; // hairline gap so individual magnets read
    const cs = [[-cellW / 2 + g, -cellH / 2 + g], [cellW / 2 - g, -cellH / 2 + g],
      [cellW / 2 - g, cellH / 2 - g], [-cellW / 2 + g, cellH / 2 - g]];
    const wc = cs.map(([a, b]) => local(a, b));
    if (sectioned(...toWorld(wc[0][0], wc[0][1], 0))) return;
    pushBox([
      ...wc.map(([u, v]) => toWorld(u, v, 0)),
      ...wc.map(([u, v]) => toWorld(u, v, magT)),
    ], rgb);
  });

  // Platen backing plate above the magnets: the structure they mount to.
  // Tiled rather than drawn as one slab, so the section cut bites it the same
  // way it bites the magnets instead of leaving a lid floating over the void.
  {
    const s = tr.cfg.platenSize / 2;
    const plateT = Math.max(tr.cfg.platenSize * 0.02, 0.0015);
    const plateRGB = pal === PALETTE.dark ? [120, 118, 112] : [176, 174, 166];
    const N = 12, step = (2 * s) / N;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u0 = -s + i * step, v0 = -s + j * step;
        const cs = [[u0, v0], [u0 + step, v0], [u0 + step, v0 + step], [u0, v0 + step]];
        const mid = toWorld(u0 + step / 2, v0 + step / 2, magT);
        if (sectioned(mid[0], mid[1])) continue;
        pushBox([
          ...cs.map(([u, v]) => toWorld(u, v, magT)),
          ...cs.map(([u, v]) => toWorld(u, v, magT + plateT)),
        // Translucent: at true scale a solid plate buries the magnet array,
        // which is the one thing you actually came to look at.
        ], plateRGB, { alpha: 0.3 });
      }
    }
  }

  painter.paint(ctx);

  // --- overlays ------------------------------------------------------------
  ctx.lineWidth = 2;
  if (trail && trail.length > 1) {
    ctx.strokeStyle = pal.s3; ctx.globalAlpha = 0.7;
    ctx.beginPath();
    let started = false;
    for (const p of trail) {
      const q = P(p);
      if (!q) { started = false; continue; }
      if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (target) {
    const t = P(target);
    if (t) {
      ctx.strokeStyle = pal.s2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(t.x, t.y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Air-gap callout: the whole point of the section view.
  {
    const gx = state.r[0] - tr.cfg.platenSize * 0.62;
    const gy = state.r[1];
    const a = P([gx, gy, 0]), b = P([gx, gy, state.r[2]]);
    if (a && b) {
      ctx.strokeStyle = pal.s2; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      for (const p of [a, b]) {
        ctx.beginPath(); ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y); ctx.stroke();
      }
      ctx.fillStyle = pal.s2;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(`${(state.r[2] * 1000).toFixed(2)} mm gap`,
        Math.min(a.x, b.x) - 6, (a.y + b.y) / 2);
    }
  }

  // Scale caveat, stated on the canvas so an exaggerated view is never
  // mistaken for the real proportions.
  if (zs !== 1) {
    ctx.fillStyle = pal.warning;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`vertical scale ×${zs}`, 12, 12);
  }
  if (sec.axis !== 'none') {
    ctx.fillStyle = pal.muted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`section: ${sec.axis} cut`, 12, zs !== 1 ? 28 : 12);
  }

  // Axis triad, bottom-left.
  const org = { x: 46, y: h - 40 };
  const axes = [
    { v: [1, 0, 0], c: pal.s8, l: 'x' },
    { v: [0, 1, 0], c: pal.s6, l: 'y' },
    { v: [0, 0, 1], c: pal.s1, l: 'z' },
  ];
  ctx.font = '11px system-ui, sans-serif';
  for (const a of axes) {
    const sx = a.v[0] * B.right[0] + a.v[1] * B.right[1] + a.v[2] * B.right[2];
    const sy = -(a.v[0] * B.up[0] + a.v[1] * B.up[1] + a.v[2] * B.up[2]);
    const l = Math.hypot(sx, sy) || 1;
    ctx.strokeStyle = a.c; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(org.x, org.y);
    ctx.lineTo(org.x + (sx / l) * 22, org.y + (sy / l) * 22); ctx.stroke();
    ctx.fillStyle = a.c; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(a.l, org.x + (sx / l) * 30 - 3, org.y + (sy / l) * 30 + 4);
  }
}

export function attachOrbit(canvas, cam, onChange) {
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lx = e.clientX; ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    cam.az -= (e.clientX - lx) * 0.008;
    cam.el = Math.max(0.05, Math.min(1.5, cam.el + (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY;
    onChange?.();
  });
  const end = () => { dragging = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(0.02, Math.min(3, cam.dist * Math.exp(e.deltaY * 0.001)));
    cam.userZoomed = true;
    onChange?.();
  }, { passive: false });
}
