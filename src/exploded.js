// Exploded assembly view. Same camera, same shading, same geometry source as
// the machine view -- the only difference is that each part is displaced along
// the assembly axis so you can see what it is and what order it goes in.
//
// The explode offset is a VIEWING transform, never a modelling one: part
// thicknesses, footprints and the air gap stay at true scale, and the callouts
// quote true dimensions. Slide the explode back to zero and you are looking at
// the machine.

import {
  theme, cameraBasis, makePainter, prepCanvas, magnetRGB,
} from './render3d.js';
import { eachCell, cellIsEmpty, cellSize } from './halbach.js';

const LABEL_W = 210;   // right-hand callout column
const ROW_H = 30;

/** Trim to fit the callout column rather than letting a long spec run off the
 *  canvas -- a truncated dimension reads as a different dimension. */
function ellipsise(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** Assign each part a displacement along z. Parts are spread from the air gap
 *  outwards, so the gap stays at the centre of the picture where it belongs. */
function explodeOffsets(parts, explode, span) {
  const gapIdx = Math.max(parts.findIndex((p) => p.kind === 'gap'), 0);
  return parts.map((_, i) => (i - gapIdx) * explode * span * 0.22);
}

export function renderExploded(canvas, scene) {
  const pal = theme();
  const { ctx, w, h } = prepCanvas(canvas, pal);
  const { cam, assembly, tr, stator } = scene;
  const explode = scene.explode ?? 1;
  const zs = scene.zScale ?? 1;
  const parts = assembly.parts;

  // Frame into the area left of the callout column rather than the whole
  // canvas, so the drawing centres in its own space instead of hiding under
  // the labels.
  const B = cameraBasis(cam, w - LABEL_W, h);
  const painter = makePainter(B, zs);
  const { P, pushBox, pushQuad } = painter;

  const span = Math.max(...parts.map((p) => p.size));
  const dz = explodeOffsets(parts, explode, span);
  const zOf = (i, z) => z + dz[i];

  const slab = (i, p, size, t, z0, rgb, opts) => {
    const s = size / 2;
    const a = zOf(i, z0), b = zOf(i, z0 + t);
    pushBox([
      [-s, -s, a], [s, -s, a], [s, s, a], [-s, s, a],
      [-s, -s, b], [s, -s, b], [s, s, b], [-s, s, b],
    ], rgb, opts);
  };

  parts.forEach((p, i) => {
    if (p.kind === 'gap') return;                       // a void has no faces

    if (p.kind === 'slab') {
      slab(i, p, p.size, p.t, p.z0, p.rgb, p.id === 'backing' ? { alpha: 0.55 } : {});
      return;
    }

    if (p.kind === 'coils') {
      for (const c of stator.coils) {
        const hx = c.outer[0] / 2, hy = c.outer[1] / 2;
        const bot = zOf(i, c.z - stator.thickness / 2), top = zOf(i, c.z + stator.thickness / 2);
        pushBox([
          [c.x - hx, c.y - hy, bot], [c.x + hx, c.y - hy, bot],
          [c.x + hx, c.y + hy, bot], [c.x - hx, c.y + hy, bot],
          [c.x - hx, c.y - hy, top], [c.x + hx, c.y - hy, top],
          [c.x + hx, c.y + hy, top], [c.x - hx, c.y + hy, top],
        ], p.rgb, { skipBottom: true });
        const ix = c.inner[0] / 2, iy = c.inner[1] / 2;
        pushQuad([[c.x - ix, c.y - iy, top], [c.x + ix, c.y - iy, top],
          [c.x + ix, c.y + iy, top], [c.x - ix, c.y + iy, top]],
        pal.plane, { bias: -1e-7 });
      }
      return;
    }

    if (p.kind === 'magnets') {
      const tile = tr.tile;
      const [cw, ch] = cellSize(tile);
      eachCell(tile, tr.patches, (px, py, k, pt) => {
        // Nulls in the pattern are empty pockets — leave the hole visible, so
        // the drawing shows the array you would actually assemble.
        if (cellIsEmpty(tile, k)) return;
        const pc = pt.cos, ps = pt.sin;
        const rgb = magnetRGB(tile.cells[k], tile.cells[k + 1], tile.cells[k + 2], tile.Br, pal);
        const g = 0.06 * cw;
        const cs = [[-cw / 2 + g, -ch / 2 + g], [cw / 2 - g, -ch / 2 + g],
          [cw / 2 - g, ch / 2 - g], [-cw / 2 + g, ch / 2 - g]];
        const wc = cs.map(([a, b]) => [pt.u + (px + a) * pc - (py + b) * ps,
          pt.v + (px + a) * ps + (py + b) * pc]);
        const z0 = zOf(i, p.z0), z1 = zOf(i, p.z0 + p.t);
        pushBox([...wc.map(([u, v]) => [u, v, z0]), ...wc.map(([u, v]) => [u, v, z1])], rgb);
      });
      return;
    }

    if (p.kind === 'retainer') {
      // Ribs on the true cell pitch, coarsened only if there are so many that
      // the drawing would be a solid block of wall. The coarsening is reported
      // on the canvas rather than quietly flattering the part.
      const nWant = Math.max(1, Math.round(p.size / p.cell));
      const nDraw = Math.min(nWant, 48);
      const step = p.size / nDraw;
      // True wall thickness, widened only if a sub-pixel rib would otherwise
      // disappear. Both facts get stated on the canvas.
      const minVisible = step * 0.06;
      const t = Math.max(p.wall, minVisible);
      const s = p.size / 2;
      const z0 = zOf(i, p.z0), z1 = zOf(i, p.z0 + p.t);
      for (let a = 0; a <= nDraw; a++) {
        const c = -s + a * step;
        pushBox([[c - t / 2, -s, z0], [c + t / 2, -s, z0], [c + t / 2, s, z0], [c - t / 2, s, z0],
          [c - t / 2, -s, z1], [c + t / 2, -s, z1], [c + t / 2, s, z1], [c - t / 2, s, z1]], p.rgb);
        pushBox([[-s, c - t / 2, z0], [s, c - t / 2, z0], [s, c + t / 2, z0], [-s, c + t / 2, z0],
          [-s, c - t / 2, z1], [s, c - t / 2, z1], [s, c + t / 2, z1], [-s, c + t / 2, z1]], p.rgb);
      }
      p._coarsened = nDraw < nWant ? { nDraw, nWant } : null;
      p._widened = t > p.wall * 1.01 ? { drawn: t, real: p.wall } : null;
    }
  });

  // Assembly axis, drawn under the parts so it reads as passing through them.
  {
    const lo = zOf(0, parts[0].z0) - span * 0.12;
    const hi = zOf(parts.length - 1, parts[parts.length - 1].z0 + parts[parts.length - 1].t) + span * 0.12;
    const a = P([0, 0, lo]), b = P([0, 0, hi]);
    if (a && b) {
      ctx.save();
      ctx.strokeStyle = pal.axis; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }
  }

  painter.paint(ctx);

  // ---- callouts -----------------------------------------------------------
  // Anchor on each part's right-most projected top corner, then lay the labels
  // out in a column, sorted by height and pushed apart so leaders never cross.
  const anchors = parts.map((p, i) => {
    const s = p.size / 2;
    const z = zOf(i, p.z0 + (p.kind === 'gap' ? p.t / 2 : p.t));
    const pts = [[-s, -s, z], [s, -s, z], [s, s, z], [-s, s, z]].map(P).filter(Boolean);
    if (!pts.length) return null;
    return pts.reduce((best, q) => (q.x > best.x ? q : best));
  });

  const rows = parts.map((p, i) => ({ p, i, a: anchors[i] })).filter((r) => r.a);
  rows.sort((a, b) => a.a.y - b.a.y);
  const colX = w - LABEL_W;
  let y = 18;
  for (const r of rows) {
    r.ly = Math.max(y, Math.min(r.a.y, h - 12));
    y = r.ly + ROW_H;
  }
  // If the column overran the canvas, compress it upward from the bottom.
  const over = y - ROW_H - (h - 12);
  if (over > 0) for (const r of rows) r.ly -= over * 0.999;

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const r of rows) {
    const isGap = r.p.kind === 'gap';
    const col = isGap ? pal.s2 : pal.ink;
    ctx.strokeStyle = isGap ? pal.s2 : pal.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.a.x, r.a.y);
    ctx.lineTo(colX - 16, r.ly);
    ctx.lineTo(colX - 8, r.ly);
    ctx.stroke();

    // Item balloon at the part.
    ctx.beginPath(); ctx.arc(r.a.x, r.a.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = pal.surface; ctx.fill();
    ctx.strokeStyle = isGap ? pal.s2 : pal.axis; ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = 'center';
    ctx.fillText(String(r.i + 1), r.a.x, r.a.y + 0.5);

    ctx.textAlign = 'left';
    ctx.fillStyle = col;
    ctx.font = '600 11px system-ui, sans-serif';
    const maxW = w - (colX - 4) - 8;
    ctx.fillText(ellipsise(ctx, `${r.i + 1}. ${r.p.name}`, maxW), colX - 4, r.ly - 6);
    ctx.fillStyle = pal.muted;
    ctx.font = '10px system-ui, sans-serif';
    // Only prefix the quantity when the spec does not already lead with it.
    const q = r.p.qty > 1 && !String(r.p.spec).startsWith(String(r.p.qty)) ? `${r.p.qty}× · ` : '';
    ctx.fillText(ellipsise(ctx, `${q}${r.p.spec}`, maxW), colX - 4, r.ly + 6);
  }

  // ---- true-scale annotations ---------------------------------------------
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const notes = [];
  if (explode > 0.02) notes.push(`exploded ×${explode.toFixed(1)} — thicknesses and gap are true scale`);
  if (zs !== 1) notes.push(`vertical scale ×${zs}`);
  const coarse = parts.find((p) => p._coarsened);
  if (coarse) notes.push(`retainer ribs drawn at ${coarse._coarsened.nDraw} of ${coarse._coarsened.nWant} — pockets coarsened for legibility`);
  const wide = parts.find((p) => p._widened);
  if (wide) notes.push(`retainer wall drawn ${(wide._widened.drawn * 1000).toFixed(2)} mm, actually ${(wide._widened.real * 1000).toFixed(2)} mm`);
  notes.forEach((n, i) => {
    ctx.fillStyle = i === 0 ? pal.muted : pal.warning;
    ctx.fillText(n, 12, 12 + i * 14);
  });
}
