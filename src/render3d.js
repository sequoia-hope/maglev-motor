// Dependency-free 3-D view: perspective projection onto a 2-D canvas with
// painter's-algorithm depth sorting. Everything drawn is a convex quad, so
// sorting by centroid depth is exact enough and costs nothing.

import { quat } from './math.js';

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

export function render(canvas, scene) {
  const pal = theme();
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

  const { cam, stator, tr, state, currents, idxMap, target, trail } = scene;
  const faces = [];
  const B = cameraBasis(cam, w, h);
  const P = (p) => project(B, p);

  // --- stator coils --------------------------------------------------------
  let iPeak = 1e-9;
  if (currents) for (let j = 0; j < currents.length; j++) iPeak = Math.max(iPeak, Math.abs(currents[j]));
  const curOf = new Map();
  if (currents && idxMap) idxMap.forEach((ci, j) => curOf.set(ci, currents[j]));

  stator.coils.forEach((c, ci) => {
    const hx = c.outer[0] / 2, hy = c.outer[1] / 2;
    const z = c.z;
    const pts = [
      P([c.x - hx, c.y - hy, z]), P([c.x + hx, c.y - hy, z]),
      P([c.x + hx, c.y + hy, z]), P([c.x - hx, c.y + hy, z]),
    ];
    if (pts.some((p) => !p)) return;
    const cur = curOf.get(ci) ?? 0;
    const active = curOf.has(ci);
    faces.push({
      d: (pts[0].d + pts[2].d) / 2,
      draw: () => {
        quadPath(ctx, pts);
        ctx.fillStyle = active ? divergingColor(cur / iPeak, pal) : pal.plane;
        ctx.fill();
        ctx.strokeStyle = active ? pal.axis : pal.grid;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Winding window hint.
        const ix = c.inner[0] / 2, iy = c.inner[1] / 2;
        const ipts = [
          P([c.x - ix, c.y - iy, z]), P([c.x + ix, c.y - iy, z]),
          P([c.x + ix, c.y + iy, z]), P([c.x - ix, c.y + iy, z]),
        ];
        if (!ipts.some((p) => !p)) {
          quadPath(ctx, ipts);
          ctx.fillStyle = pal.surface;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      },
    });
  });

  // --- translator ----------------------------------------------------------
  const R = quat.toMat3(state.q);
  const toWorld = (u, v, zz) => [
    state.r[0] + R[0] * u + R[1] * v + R[2] * zz,
    state.r[1] + R[3] * u + R[4] * v + R[5] * zz,
    state.r[2] + R[6] * u + R[7] * v + R[8] * zz,
  ];

  const tile = tr.tile;
  const cellW = tile.lx / tile.nx;
  const cellH = tile.ly / tile.ny;
  const platenTop = tr.cfg.magnetThickness;

  tr.patches.forEach((pt) => {
    const ct = pt.cos, st = pt.sin;
    const nu = Math.ceil(pt.w / cellW), nv = Math.ceil(pt.h / cellH);
    for (let jv = 0; jv < nv; jv++) {
      for (let iu = 0; iu < nu; iu++) {
        const px = -pt.w / 2 + (iu + 0.5) * cellW;
        const py = -pt.h / 2 + (jv + 0.5) * cellH;
        if (Math.abs(px) > pt.w / 2 || Math.abs(py) > pt.h / 2) continue;
        // Which tile cell is this?
        const tx = ((px % tile.lx) + tile.lx) % tile.lx;
        const ty = ((py % tile.ly) + tile.ly) % tile.ly;
        const ci = Math.min(tile.nx - 1, Math.floor((tx / tile.lx) * tile.nx));
        const cj = Math.min(tile.ny - 1, Math.floor((ty / tile.ly) * tile.ny));
        const k = (cj * tile.nx + ci) * 3;
        const col = magnetColor(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2], tile.Br, pal);

        const corners = [
          [-cellW / 2, -cellH / 2], [cellW / 2, -cellH / 2],
          [cellW / 2, cellH / 2], [-cellW / 2, cellH / 2],
        ].map(([a, b]) => {
          const u = pt.u + (px + a) * ct - (py + b) * st;
          const v = pt.v + (px + a) * st + (py + b) * ct;
          return P(toWorld(u, v, 0));
        });
        if (corners.some((p) => !p)) continue;
        faces.push({
          d: (corners[0].d + corners[2].d) / 2,
          draw: () => {
            quadPath(ctx, corners);
            ctx.fillStyle = col;
            ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.18)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          },
        });
      }
    }
  });

  // Platen body (top slab), drawn as a translucent box lid.
  {
    const s = tr.cfg.platenSize / 2;
    const lid = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => P(toWorld(u, v, platenTop)));
    if (!lid.some((p) => !p)) {
      faces.push({
        d: (lid[0].d + lid[2].d) / 2 - 1e-6,
        draw: () => {
          quadPath(ctx, lid);
          ctx.fillStyle = pal === PALETTE.dark ? 'rgba(255,255,255,0.10)' : 'rgba(11,11,11,0.10)';
          ctx.fill();
          ctx.strokeStyle = pal.ink2;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        },
      });
    }
  }

  faces.sort((a, b) => b.d - a.d);
  for (const f of faces) f.draw();

  // --- overlays (always on top) -------------------------------------------
  ctx.lineWidth = 2;

  if (trail && trail.length > 1) {
    ctx.strokeStyle = pal.s3;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    let started = false;
    for (const p of trail) {
      const q = P(p);
      if (!q) { started = false; continue; }
      if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (target) {
    const t = P(target);
    if (t) {
      ctx.strokeStyle = pal.s2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Air-gap indicator: a dropped line from the platen centre to the stator.
  {
    const a = P(state.r), b = P([state.r[0], state.r[1], 0]);
    if (a && b) {
      ctx.strokeStyle = pal.muted;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Axis triad, bottom-left. Directions come straight from the camera basis so
  // it always agrees with the view.
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
    ctx.strokeStyle = a.c;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(org.x, org.y);
    ctx.lineTo(org.x + (sx / l) * 22, org.y + (sy / l) * 22);
    ctx.stroke();
    ctx.fillStyle = a.c;
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
