// Minimal canvas chart kit: line charts, heatmaps, bar strips. Deliberately
// plain -- recessive grid, thin marks, one axis, direct labels where they fit,
// hover readout on everything.

import { theme, sequentialColor, divergingColor, PALETTE } from './render3d.js';

const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_B = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';

function setup(canvas) {
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
  return { ctx, w, h, pal };
}

function niceTicks(lo, hi, count = 5) {
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-30) return [lo];
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  // Snap to exact multiples of the step: accumulating floats turns a tick that
  // should read "0" into "5.5e-18", which then blows out the axis gutter.
  for (let i = Math.ceil(lo / step); i * step <= hi + step * 1e-6; i++) out.push(i * step);
  return out;
}

function fmt(v, digits = 3) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-3) return v.toExponential(1);
  return String(Number(v.toPrecision(digits)));
}

/** Line chart. series: [{label, color, pts: [[x,y],...], dashed?}] */
export function lineChart(canvas, opts) {
  const { ctx, w, h, pal } = setup(canvas);
  const { series, xLabel = '', yLabel = '', yZero = false, title = '', hover } = opts;
  const pad = { l: 56, r: 12, t: title ? 26 : 12, b: 34 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of series) for (const p of s.pts) {
    if (!isFinite(p[0]) || !isFinite(p[1])) continue;
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  if (!isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
  if (opts.xRange) { x0 = opts.xRange[0]; x1 = opts.xRange[1]; }
  if (opts.yRange) { y0 = opts.yRange[0]; y1 = opts.yRange[1]; }
  else {
    if (yZero) y0 = Math.min(0, y0);
    const m = (y1 - y0) * 0.08 || 1e-6;
    y0 -= m; y1 += m;
  }
  const X = (v) => pad.l + ((v - x0) / (x1 - x0 || 1)) * pw;
  const Y = (v) => pad.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;

  if (title) {
    // The 2-D context is reused across charts, so alignment set by a previous
    // draw carries over. Always state it explicitly.
    ctx.fillStyle = pal.ink; ctx.font = FONT_B;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, pad.l, 16);
  }

  // Grid + ticks
  ctx.font = FONT;
  ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
  ctx.fillStyle = pal.muted;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const t of niceTicks(y0, y1, 5)) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.fillText(fmt(t), pad.l - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of niceTicks(x0, x1, 6)) {
    const x = Math.round(X(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
    ctx.fillText(fmt(t), x, pad.t + ph + 6);
  }
  ctx.strokeStyle = pal.axis;
  ctx.beginPath();
  ctx.moveTo(pad.l + 0.5, pad.t); ctx.lineTo(pad.l + 0.5, pad.t + ph);
  ctx.lineTo(pad.l + pw, pad.t + ph + 0.5);
  ctx.stroke();

  ctx.fillStyle = pal.ink2;
  if (xLabel) { ctx.textAlign = 'center'; ctx.fillText(xLabel, pad.l + pw / 2, h - 13); }
  if (yLabel) {
    ctx.save(); ctx.translate(11, pad.t + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(yLabel, 0, 0); ctx.restore();
  }

  // Marks
  ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const s of series) {
    ctx.strokeStyle = s.color;
    if (s.dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let started = false;
    for (const p of s.pts) {
      if (!isFinite(p[1])) { started = false; continue; }
      const px = X(p[0]), py = Y(p[1]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Legend: always present for >=2 series; a single series is named by the title.
  if (series.length >= 2) {
    ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let lx = pad.l + 4, ly = pad.t + 9;
    for (const s of series) {
      const tw = ctx.measureText(s.label).width;
      if (lx + tw + 22 > pad.l + pw) { lx = pad.l + 4; ly += 15; }
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly - 3, 10, 3);
      ctx.fillStyle = pal.ink2;
      ctx.fillText(s.label, lx + 14, ly);
      lx += tw + 26;
    }
  }

  // Crosshair readout
  if (hover && hover.x >= pad.l && hover.x <= pad.l + pw) {
    const xv = x0 + ((hover.x - pad.l) / pw) * (x1 - x0);
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hover.x, pad.t); ctx.lineTo(hover.x, pad.t + ph); ctx.stroke();
    ctx.setLineDash([]);
    const rows = [];
    for (const s of series) {
      let best = null, bd = Infinity;
      for (const p of s.pts) {
        const d = Math.abs(p[0] - xv);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) rows.push({ label: s.label, color: s.color, v: best[1], p: best });
    }
    for (const r of rows) {
      if (!isFinite(r.v)) continue;
      ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.arc(X(r.p[0]), Y(r.v), 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = pal.surface; ctx.lineWidth = 2; ctx.stroke();
    }
    const lines = [`${xLabel || 'x'} = ${fmt(xv)}`, ...rows.map((r) => `${r.label}: ${fmt(r.v)}`)];
    tooltip(ctx, pal, hover.x + 10, pad.t + 8, lines, w);
  }
  return { X, Y, pad, pw, ph, x0, x1, y0, y1 };
}

function tooltip(ctx, pal, x, y, lines, w) {
  ctx.font = FONT;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
  const th = lines.length * 14 + 10;
  const px = Math.min(x, w - tw - 4);
  ctx.fillStyle = pal === PALETTE.dark ? 'rgba(26,26,25,0.95)' : 'rgba(252,252,251,0.96)';
  ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, y, tw, th, 4); else ctx.rect(px, y, tw, th);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = pal.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, px + 7, y + 6 + i * 14));
}

/** Heatmap over a rectangular domain. data is a Float64Array of nx*ny (row
 *  major, y outer). mode 'sequential' | 'diverging'. */
export function heatmap(canvas, opts) {
  const { ctx, w, h, pal } = setup(canvas);
  const {
    data, nx, ny, extent, title = '', xLabel = '', yLabel = '',
    mode = 'sequential', units = '', hover, overlays = [],
  } = opts;
  const pad = { l: yLabel ? 62 : 44, r: 62, t: title ? 26 : 12, b: xLabel ? 36 : 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (!isFinite(data[i])) continue;
    lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]);
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (mode === 'diverging') { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
  const span = hi - lo || 1;
  const colorOf = (v) => (mode === 'diverging'
    ? divergingColor(v / (hi || 1), pal)
    : sequentialColor((v - lo) / span));

  // Render the grid into an offscreen image, then scale it up.
  const img = ctx.createImageData(nx, ny);
  const tmp = document.createElement('canvas');
  tmp.width = nx; tmp.height = ny;
  for (let i = 0; i < nx * ny; i++) {
    const c = colorOf(data[i]);
    const m = c.match(/\d+/g);
    img.data[i * 4] = +m[0]; img.data[i * 4 + 1] = +m[1];
    img.data[i * 4 + 2] = +m[2]; img.data[i * 4 + 3] = 255;
  }
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  // Flip vertically: data row 0 is the LOW y edge, canvas row 0 is the top.
  ctx.save();
  ctx.translate(pad.l, pad.t + ph);
  ctx.scale(1, -1);
  ctx.drawImage(tmp, 0, 0, pw, ph);
  ctx.restore();

  if (title) { ctx.fillStyle = pal.ink; ctx.font = FONT_B; ctx.textAlign = 'left'; ctx.fillText(title, pad.l, 16); }

  const X = (v) => pad.l + ((v - extent[0]) / (extent[1] - extent[0])) * pw;
  const Y = (v) => pad.t + ph - ((v - extent[2]) / (extent[3] - extent[2])) * ph;

  ctx.font = FONT; ctx.fillStyle = pal.muted;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of niceTicks(extent[0], extent[1], 5)) ctx.fillText(fmt(t), X(t), pad.t + ph + 5);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const t of niceTicks(extent[2], extent[3], 5)) ctx.fillText(fmt(t), pad.l - 5, Y(t));
  ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
  ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, pw, ph);

  ctx.fillStyle = pal.ink2;
  if (xLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(xLabel, pad.l + pw / 2, h - 6); }
  if (yLabel) {
    ctx.save(); ctx.translate(12, pad.t + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(yLabel, 0, 0); ctx.restore();
  }

  for (const ov of overlays) {
    ctx.strokeStyle = ov.color; ctx.lineWidth = 2;
    ctx.setLineDash(ov.dashed ? [4, 4] : []);
    ctx.beginPath();
    if (ov.type === 'rect') ctx.rect(X(ov.x0), Y(ov.y1), X(ov.x1) - X(ov.x0), Y(ov.y0) - Y(ov.y1));
    else ctx.arc(X(ov.x), Y(ov.y), ov.r ?? 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Colour bar
  const cbx = pad.l + pw + 14, cbw = 12;
  for (let i = 0; i < ph; i++) {
    ctx.fillStyle = colorOf(lo + (span * (ph - i)) / ph);
    ctx.fillRect(cbx, pad.t + i, cbw, 1);
  }
  ctx.strokeStyle = pal.axis; ctx.strokeRect(cbx + 0.5, pad.t + 0.5, cbw, ph);
  ctx.fillStyle = pal.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(fmt(hi), cbx + cbw + 4, pad.t + 6);
  ctx.fillText(fmt(lo), cbx + cbw + 4, pad.t + ph - 6);
  if (units) {
    ctx.save(); ctx.translate(w - 6, pad.t + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = pal.ink2; ctx.fillText(units, 0, 0); ctx.restore();
  }

  if (hover && hover.x > pad.l && hover.x < pad.l + pw && hover.y > pad.t && hover.y < pad.t + ph) {
    const fx = (hover.x - pad.l) / pw, fy = 1 - (hover.y - pad.t) / ph;
    const ix = Math.min(nx - 1, Math.floor(fx * nx));
    const iy = Math.min(ny - 1, Math.floor(fy * ny));
    const v = data[iy * nx + ix];
    const xv = extent[0] + fx * (extent[1] - extent[0]);
    const yv = extent[2] + fy * (extent[3] - extent[2]);
    ctx.strokeStyle = pal.ink; ctx.lineWidth = 1.5;
    ctx.strokeRect(pad.l + (ix / nx) * pw, pad.t + ph - ((iy + 1) / ny) * ph, pw / nx, ph / ny);
    tooltip(ctx, pal, hover.x + 10, hover.y - 44,
      [`${xLabel || 'x'} ${fmt(xv)}`, `${yLabel || 'y'} ${fmt(yv)}`, `${fmt(v, 4)} ${units}`], w);
  }
  return { lo, hi };
}

/** Signed bar strip, used for the live coil-current display. */
export function barStrip(canvas, values, opts = {}) {
  const { ctx, w, h, pal } = setup(canvas);
  const { title = '', units = 'A', hover, labels } = opts;
  const pad = { l: 8, r: 8, t: title ? 22 : 6, b: 16 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const n = values.length;
  if (n === 0) {
    ctx.fillStyle = pal.muted; ctx.font = FONT; ctx.textAlign = 'center';
    ctx.fillText('no active coils', w / 2, h / 2);
    return;
  }
  let peak = 1e-9;
  for (const v of values) peak = Math.max(peak, Math.abs(v));
  const mid = pad.t + ph / 2;

  if (title) { ctx.fillStyle = pal.ink; ctx.font = FONT_B; ctx.textAlign = 'left'; ctx.fillText(title, pad.l, 14); }
  ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, mid + 0.5); ctx.lineTo(pad.l + pw, mid + 0.5); ctx.stroke();

  const bw = Math.max(1, pw / n - 2);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const bh = (Math.abs(v) / peak) * (ph / 2 - 2);
    ctx.fillStyle = divergingColor(v / peak, pal);
    const x = pad.l + (i * pw) / n + 1;
    ctx.fillRect(x, v >= 0 ? mid - bh : mid, bw, Math.max(bh, 0.6));
  }
  ctx.fillStyle = pal.muted; ctx.font = FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`peak ${fmt(peak)} ${units}  ·  ${n} coils`, w - pad.r, h - 3);

  if (hover && hover.x > pad.l && hover.x < pad.l + pw) {
    const i = Math.min(n - 1, Math.floor(((hover.x - pad.l) / pw) * n));
    tooltip(ctx, pal, hover.x + 10, pad.t,
      [labels ? labels(i) : `coil ${i}`, `${fmt(values[i], 4)} ${units}`], w);
  }
}

/** Attach pointer tracking; calls redraw with {x,y} or null. */
export function trackHover(canvas, redraw) {
  const st = { pos: null };
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    st.pos = { x: e.clientX - r.left, y: e.clientY - r.top };
    redraw(st.pos);
  });
  canvas.addEventListener('pointerleave', () => { st.pos = null; redraw(null); });
  return st;
}
