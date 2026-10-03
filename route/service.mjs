// Put the board-level SERVICE parts back on the quad-stamp board: the 2x5
// spine header (JSPINE) and the /OE dead-man (RDM1, CDM1, RDM2, QDM1).
// quadgen strips them because the uniform per-cell placement cannot hold
// them; here they go where the bare board has room, BEFORE routing, so the
// assembler treats their pads as static copper: stamp paths that would cross
// them are dropped at pattern time and re-routed by the patch stage.
//
//   node service.mjs <bareKey> <outKey>      env: NEAR="x,y" search centre (board mm)
import { readFileSync, writeFileSync, copyFileSync } from 'fs';

const B = process.argv[2], OUT = process.argv[3];
let txt = readFileSync(`${B}.kicad_pcb`, 'utf8');
const netNum = new Map();
for (const m of txt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netNum.set(m[2], +m[1]);
const outline = [];
for (const m of txt.matchAll(/\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)/g)) outline.push([+m[1], +m[2], +m[3], +m[4]]);
let maxX = -1e9, maxY = -1e9, minX = 1e9, minY = 1e9;
for (const [a, b, c, d] of outline) { maxX = Math.max(maxX, a, c); maxY = Math.max(maxY, b, d); minX = Math.min(minX, a, c); minY = Math.min(minY, b, d); }
const vias = [];
for (const m of txt.matchAll(/^  \(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\)/gm)) vias.push([+m[1], +m[2], +m[3] / 2]);
const rects = [];                                  // every pad on the board {x, y, w, h, deg}
for (const m of txt.matchAll(/  \(footprint "maglev:[^"]+" \(layer "[^"]+"\) \(at ([-\d.]+) ([-\d.]+)\)([\s\S]*?)\n  \)\n/g)) {
  for (const p of m[3].matchAll(/\(pad "[^"]+" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\)/g)) {
    rects.push({ x: +m[1] + +p[1], y: +m[2] + +p[2], deg: +(p[3] || 0), w: +p[4], h: +p[5] });
  }
}
const M = netNum.size ? Math.max(...[...netNum.keys()].map((n) => (/^DATA_(\d+)$/.exec(n) || [0, -1])[1]).map(Number)) : 0;
for (const n of ['SYNC', 'DEADMAN_G', 'VBUS', 'GND', 'VLOGIC', 'SCLK', 'RCLK', 'OE_N', 'SDA', 'SCL', 'DATA_0', `DATA_${M}`]) {
  if (!netNum.has(n)) throw new Error(`board has no net ${n}`);
}

// footprints, pads in the FILE frame (y down): [name, dx, dy, w, h, net]
const header = (rot) => {
  // pads 1-5 are one row, 6-10 the other, so pad k and pad k+5 face each other.
  // HDR_NETS reorders the pinout (comma list, DATA_M = the chain's last net).
  const nets = (process.env.HDR_NETS || 'VBUS,GND,VLOGIC,DATA_0,DATA_M,SCLK,RCLK,SYNC,SDA,SCL').split(',').map((n) => (n === 'DATA_M' ? `DATA_${M}` : n));
  if (nets.length !== 10 || new Set(nets).size !== 10) throw new Error('HDR_NETS wants ten distinct nets');
  const pads = [];
  [0.635, -0.635].forEach((yUp, r) => { for (let k = 0; k < 5; k++) pads.push([String(r * 5 + k + 1), (k - 2) * 1.27, -yUp, 0.74, 0.74, nets[r * 5 + k]]); });
  return { lib: 'HDR10', ref: 'JSPINE', value: '1.27-2*5PLTM', lcsc: 'C59983', body: [7.0, 3.4], pads, rot };
};
const r0402 = (ref, value, lcsc, a, b) => ({ lib: 'R0402', ref, value, lcsc, body: [1.4, 0.7], pads: [['1', -0.5, 0, 0.4, 0.5, a], ['2', 0.5, 0, 0.4, 0.5, b]] });
const sot23 = () => ({ lib: 'SOT23', ref: 'QDM1', value: '2N7002,215', lcsc: 'C8545', body: [2.9, 2.9],
  pads: [['1', -0.95, -1.0, 0.6, 0.7, 'DEADMAN_G'], ['2', 0.95, -1.0, 0.6, 0.7, 'GND'], ['3', 0, 1.0, 0.6, 0.7, 'OE_N']] });

// ---- fit test: rotated rectangles against barrels, pads, the cut -------------------
const rot = (dx, dy, deg) => { const a = (deg * Math.PI) / 180; return [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)]; };
const placedPads = (fp, x, y, deg) => fp.pads.map(([name, dx, dy, w, h, net]) => { const [qx, qy] = rot(dx, dy, deg); return { name, x: x + qx, y: y + qy, w, h, deg, net }; });
const ptRect = (px, py, r) => {                    // distance from a point to a rotated rect
  const a = (r.deg * Math.PI) / 180, dx = px - r.x, dy = py - r.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.hypot(Math.max(Math.abs(lx) - r.w / 2, 0), Math.max(Math.abs(ly) - r.h / 2, 0));
};
const corners = (r) => { const a = (r.deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([u, v]) => [r.x + u * r.w / 2 * c + v * r.h / 2 * s, r.y - u * r.w / 2 * s + v * r.h / 2 * c]); };
const rectRect = (a, b) => Math.min(...corners(a).map(([x, y]) => ptRect(x, y, b)), ...corners(b).map(([x, y]) => ptRect(x, y, a)));
const ptSeg = (px, py, [x0, y0, x1, y1]) => { const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy; const t = L > 1e-12 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L)) : 0; return Math.hypot(px - x0 - t * dx, py - y0 - t * dy); };
const inside = (x, y) => { let odd = false; for (const [x0, y0, x1, y1] of outline) if ((y0 > y) !== (y1 > y) && x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) odd = !odd; return odd; };
// every land keeps a routable gap (one track + two clearances = 0.28 mm, plus
// slack) to every barrel and foreign land: a service pad parked against a
// gutter via seals the pocket behind it -- the first placement (0.21 mm from a
// barrel) left PWMA_10 with no way to its own bridge pad
const MINCLR = +(process.env.MINCLR || 0.45);
const others = [];                                 // service pads already committed
const slack = (fp, x, y, deg) => {                 // worst clearance of this placement, or -1
  let worst = 1e9;
  const pads = placedPads(fp, x, y, deg);
  const body = { x, y, w: fp.body[0], h: fp.body[1], deg };
  for (const p of pads) {
    if (!inside(p.x, p.y)) return -1;
    for (const e of outline) { if (Math.abs(e[0] - p.x) > 12 && Math.abs(e[2] - p.x) > 12) continue; for (const [cx, cy] of corners(p)) worst = Math.min(worst, ptSeg(cx, cy, e) - 0.3); }
    for (const [vx, vy, vr] of vias) { if (Math.abs(vx - p.x) > 2 || Math.abs(vy - p.y) > 2) continue; worst = Math.min(worst, ptRect(vx, vy, p) - vr); }
    for (const r of rects) { if (Math.abs(r.x - p.x) > 3 || Math.abs(r.y - p.y) > 3) continue; worst = Math.min(worst, rectRect(p, r)); }
    for (const r of others) worst = Math.min(worst, rectRect(p, r) - 0.15);
    if (worst < MINCLR) return -1;
  }
  // the body may sit over barrels, never over another part's lands
  for (const r of [...rects, ...others]) { if (Math.abs(r.x - x) > 6 || Math.abs(r.y - y) > 6) continue; if (rectRect(body, r) < 0.1) return -1; }
  return worst;
};
const near = (process.env.NEAR || `${maxX - 12},${maxY - 6}`).split(',').map(Number);
const place = (fp, centre, reach, rots) => {
  let best = null;
  const forced = process.env[`${fp.ref}_AT`];
  if (forced) {
    const [x, y, deg] = forced.split(',').map(Number), s = slack(fp, x, y, deg);
    if (s < 0) throw new Error(`${fp.ref}_AT=${forced} does not fit`);
    best = { x, y, deg, s, score: 0 };
  }
  const all = [];
  for (let dx = -reach; dx <= reach + 1e-9; dx += 0.1) for (let dy = -reach; dy <= reach + 1e-9; dy += 0.1) for (const deg of rots) {
    const x = +(centre[0] + dx).toFixed(3), y = +(centre[1] + dy).toFixed(3);
    const s = slack(fp, x, y, deg);
    if (s < 0 || forced) continue;
    all.push({ x, y, deg, s });
    const score = Math.min(s, 1.0) * 10 - Math.hypot(dx, dy) * 0.25;   // roomy first, then close
    if (!best || score > best.score) best = { x, y, deg, s, score };
  }
  if (!best) throw new Error(`no room for ${fp.ref} within ${reach} mm of ${centre}`);
  if (process.env.LIST && fp.ref === 'JSPINE') {   // distinct candidates, roomiest first
    const pick = [];
    for (const c of all.sort((a, b) => b.s - a.s)) if (!pick.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 1.5)) pick.push(c);
    for (const c of pick.slice(0, +process.env.LIST)) console.log(`CAND ${c.x},${c.y},${c.deg} ${c.s.toFixed(3)}`);
    process.exit(0);
  }
  for (const p of placedPads(fp, best.x, best.y, best.deg)) others.push(p);
  others.push({ x: best.x, y: best.y, w: fp.body[0], h: fp.body[1], deg: best.deg });
  console.log(`${fp.ref.padEnd(6)} at (${best.x}, ${best.y}) rot ${best.deg}  worst pad clearance ${best.s.toFixed(3)} mm`);
  return { fp, ...best };
};
const parts = [];
const H = place(header(0), near, +(process.env.REACH || 12), [0, 90]);
parts.push(H);
for (const fp of [sot23(), r0402('RDM1', '100k', 'C25741', 'SYNC', 'DEADMAN_G'), r0402('CDM1', '100n', 'C1525', 'DEADMAN_G', 'GND'), r0402('RDM2', '100k', 'C25741', 'OE_N', 'VLOGIC')]) {
  parts.push(place(fp, [H.x, H.y], 9, [0, 90, 180, 270]));
}

// ---- the power FEED -------------------------------------------------------------------
// The header's VBUS and GND pins are SMD pads over a coil face: the only way
// into the board is a barrel in the nearest gutter, and left to the router that
// is one 0.1 mm track to wherever it found one (measured on the first full
// board: GND reached the mesh through 6 mm of track and another bridge's pad).
// So each power pin gets its own barrels HERE, before routing, while the
// gutter is still empty -- the nearest sites that are legal through all
// fourteen layers -- and a copper TAB from the pin to each (an extra,
// mask-covered pad of the same pin, so every tool sees it as that pin's
// copper). pour.py lands its rails on those barrels.
//
// OFF BY DEFAULT, because it has been route-tested and the header quad does
// not survive it (2026-10-02, six full runs, ~90 min each): any barrel in the
// seam west of the header takes one of the crossing slots between ladder
// barrels that the register's PWM tracks need, and barrels in the gutter south
// of it are no better -- A (2+2): 3 open, B (VBUS 2, GND 1): 3, C (1+1): 4,
// D (GND 1 only): 4, E (GND 1 at the other site): 2, K (GND moved to the pin
// facing VBUS, both fed from the south gutter): 9. Electrically every one of
// them was right: hover drop 12-20 mV, loop <= 150 mohm. The quad with the
// header is at the edge of routability; the feed wants a different header
// spot or pinout, which is a design decision. Without barrels, pour.py feeds
// the pins through B.Cu pours and whatever barrel the router left beside them.
//   FEED_AT="GND:x,y" forces a site; FEED_VIAS=n per power pin (default 0; or "VBUS:2,GND:1"), FEED_REACH mm (1.5)
const feedSpec = String(process.env.FEED_VIAS ?? 0);  // "2", or per net: "VBUS:2,GND:1"
const feedN = (net) => (feedSpec.includes(':') ? +(Object.fromEntries(feedSpec.split(',').map((s) => s.split(':')))[net] ?? 0) : +feedSpec);
const FEED_VIAS = Math.max(feedN('VBUS'), feedN('GND')), FEED_REACH = +(process.env.FEED_REACH || 1.5);
const VIA = { r: 0.25, hole: 0.115 }, CLR = 0.09, TABW = 0.5;
const feedVias = [], feedTabs = [];
if (FEED_VIAS > 0) {
  const hp = placedPads(H.fp, H.x, H.y, H.deg);
  const nearH = (x, y) => Math.abs(x - H.x) < 8 && Math.abs(y - H.y) < 8;
  const cu = [];                                   // winding copper near the header, every layer: [ax, ay, bx, by, halfwidth]
  for (const m of txt.matchAll(/^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "[^"]+"\) \(net \d+\)\)/gm)) {
    if (nearH(+m[1], +m[2]) || nearH(+m[3], +m[4])) cu.push([+m[1], +m[2], +m[3], +m[4], +m[5] / 2]);
  }
  for (const m of txt.matchAll(/^  \(arc \(start ([-\d.]+) ([-\d.]+)\) \(mid ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "[^"]+"\) \(net \d+\)\)/gm)) {
    const [sx, sy, mx, my, ex, ey] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
    if (!nearH(sx, sy) && !nearH(ex, ey)) continue;
    const d = 2 * (sx * (my - ey) + mx * (ey - sy) + ex * (sy - my));
    if (Math.abs(d) < 1e-12) { cu.push([sx, sy, ex, ey, +m[7] / 2]); continue; }
    const ux = ((sx * sx + sy * sy) * (my - ey) + (mx * mx + my * my) * (ey - sy) + (ex * ex + ey * ey) * (sy - my)) / d;
    const uy = ((sx * sx + sy * sy) * (ex - mx) + (mx * mx + my * my) * (sx - ex) + (ex * ex + ey * ey) * (mx - sx)) / d;
    const r = Math.hypot(sx - ux, sy - uy), a0 = Math.atan2(sy - uy, sx - ux), norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a1 = Math.atan2(my - uy, mx - ux), a2 = Math.atan2(ey - uy, ex - ux);
    const sweep = norm(a1 - a0) < norm(a2 - a0) ? norm(a2 - a0) : -norm(a0 - a2);
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / 0.04));
    for (let k = 0; k < n; k++) cu.push([ux + r * Math.cos(a0 + (sweep * k) / n), uy + r * Math.sin(a0 + (sweep * k) / n), ux + r * Math.cos(a0 + (sweep * (k + 1)) / n), uy + r * Math.sin(a0 + (sweep * (k + 1)) / n), +m[7] / 2]);
  }
  const allPads = [...rects.map((r) => ({ ...r, net: null })), ...others.filter((o) => o.net)];   // every land; only the service pads know their net
  const legal = (x, y, net) => {
    if (!inside(x, y)) return false;
    for (const e of outline) if (ptSeg(x, y, e) < VIA.r + 0.2 + 0.02) return false;
    for (const [ax, ay, bx, by, hw] of cu) if (ptSeg(x, y, [ax, ay, bx, by]) - hw < VIA.r + CLR + 0.02) return false;
    for (const [vx, vy, vr] of [...vias, ...feedVias.map((v) => [v.x, v.y, VIA.r])]) if (Math.hypot(vx - x, vy - y) < VIA.r + vr + CLR + 0.01) return false;
    for (const p of allPads) if (p.net !== net && ptRect(x, y, p) < VIA.r + CLR + 0.02) return false;
    return true;
  };
  const tabOf = (p, x, y) => {                     // a rect from the pin to the barrel, or null if it crowds anything
    const dx = x - p.x, dy = y - p.y, len = Math.hypot(dx, dy);
    const tab = { x: (p.x + x) / 2, y: (p.y + y) / 2, w: len + TABW, h: TABW, deg: (Math.atan2(-dy, dx) * 180) / Math.PI };
    for (const q of allPads) if (q.net !== p.net && rectRect(tab, q) < CLR + 0.015) return null;
    for (const [vx, vy, vr] of vias) if (ptRect(vx, vy, tab) - vr < CLR + 0.015) return null;
    for (const v of feedVias) if (v.net !== p.net && ptRect(v.x, v.y, tab) - VIA.r < CLR + 0.015) return null;
    return tab;
  };
  // FEED_AT="GND:x,y;VBUS:x,y" forces a pin's first site (it must still be legal)
  const feedAt = Object.fromEntries((process.env.FEED_AT || '').split(';').filter(Boolean).map((s) => { const [n, xy] = s.split(':'); return [n, xy.split(',').map(Number)]; }));
  for (const p of hp.filter((q) => (q.net === 'VBUS' || q.net === 'GND') && feedN(q.net) > 0)) {
    const cand = [];
    if (feedAt[p.net]) { const [x, y] = feedAt[p.net]; if (!legal(x, y, p.net)) throw new Error(`FEED_AT ${p.net} ${x},${y} is not a legal barrel site`); cand.push({ x, y, d: -1 }); }
    for (let dx = -FEED_REACH - 0.6; dx <= FEED_REACH + 0.6; dx += 0.05) for (let dy = -FEED_REACH - 0.6; dy <= FEED_REACH + 0.6; dy += 0.05) {
      const x = +(p.x + dx).toFixed(3), y = +(p.y + dy).toFixed(3), d = ptRect(x, y, p);
      // the land stays clear of the pin's own mask opening: an open barrel in a
      // solder pad wicks the joint away
      if (!feedAt[p.net] && d >= VIA.r + 0.1 && d <= FEED_REACH && legal(x, y, p.net)) cand.push({ x, y, d });
    }
    cand.sort((a, b) => a.d - b.d);
    if (process.env.FEED_LIST) console.log(`sites ${p.net}: ` + cand.filter((c, k) => k % 6 === 0).map((c) => `${c.x},${c.y}`).join(' '));
    const mine = [];
    // nearest first; after that, the site nearest the barrels already taken, so a
    // pin's barrels stand together in one gutter instead of fencing the pin in
    const next = () => (mine.length ? [...cand].sort((a, b) => Math.min(...mine.map((v) => Math.hypot(v.x - a.x, v.y - a.y))) - Math.min(...mine.map((v) => Math.hypot(v.x - b.x, v.y - b.y)))) : cand);
    while (mine.length < feedN(p.net)) {
      let took = false;
      for (const c of next()) {
        if (mine.some((v) => Math.hypot(v.x - c.x, v.y - c.y) < 2 * VIA.r + CLR + 0.01)) continue;   // two lands with a clearance between: the router's own via-via rule
        if (!legal(c.x, c.y, p.net)) continue;     // against the feed barrels already taken
        // the tab runs from the pin, or failing that from a barrel this pin already has
        const tab = tabOf(p, c.x, c.y) || mine.map((v) => tabOf({ ...p, x: v.x, y: v.y }, c.x, c.y)).find(Boolean);
        if (!tab) continue;
        mine.push(c); feedVias.push({ x: c.x, y: c.y, net: p.net }); feedTabs.push({ pin: p.name, net: p.net, tab });
        took = true; break;
      }
      if (!took) break;
    }
    console.log(`feed ${p.net.padEnd(4)} pin ${p.name}: ${mine.length} barrel(s) ${mine.map((v) => `(${v.x}, ${v.y}) ${v.d.toFixed(2)} mm from the pin`).join(', ') || '-- NO LEGAL SITE within reach'}`);
    if (!mine.length) throw new Error(`no feed barrel for ${p.net}: raise FEED_REACH or move the header`);
  }
}

// ---- emit ----------------------------------------------------------------------------
const f = (v) => +v.toFixed(4);
const L = [];
for (const { fp, x, y, deg } of parts) {
  L.push(`  (footprint "maglev:${fp.lib}" (layer "B.Cu") (at ${f(x)} ${f(y)})`);
  L.push('    (attr smd)');
  L.push(`    (fp_text reference "${fp.ref}" (at 0 ${-(fp.body[1] / 2 + 0.5)}) (layer "B.SilkS") (effects (font (size 0.35 0.35) (thickness 0.06)) (justify mirror)))`);
  L.push(`    (fp_text value "${fp.value}" (at 0 ${fp.body[1] / 2 + 0.5}) (layer "B.Fab") hide (effects (font (size 0.35 0.35) (thickness 0.06)) (justify mirror)))`);
  L.push(`    (property "LCSC" "${fp.lcsc}")`);
  for (const [name, dx, dy, w, h, net] of fp.pads) {
    const [qx, qy] = rot(dx, dy, deg);
    L.push(`    (pad "${name}" smd rect (at ${f(qx)} ${f(qy)}${deg ? ` ${deg}` : ''}) (size ${w} ${h}) (layers "B.Cu" "B.Paste" "B.Mask") (net ${netNum.get(net)} "${net}"))`);
  }
  if (fp.ref === 'JSPINE') for (const { pin, net, tab } of feedTabs) {
    L.push(`    (pad "${pin}" smd rect (at ${f(tab.x - x)} ${f(tab.y - y)} ${f(tab.deg)}) (size ${f(tab.w)} ${f(tab.h)}) (layers "B.Cu") (net ${netNum.get(net)} "${net}"))`);
  }
  L.push('  )');
}
for (const v of feedVias) L.push(`  (via (at ${f(v.x)} ${f(v.y)}) (size 0.5) (drill 0.23) (layers "F.Cu" "B.Cu") (net ${netNum.get(v.net)}))`);
const cut = txt.lastIndexOf('\n)');
writeFileSync(`${OUT}.kicad_pcb`, txt.slice(0, cut) + '\n' + L.join('\n') + txt.slice(cut));
for (const ext of ['kicad_dru', 'kicad_pro', 'quads.json']) copyFileSync(`${B}.${ext}`, `${OUT}.${ext}`);
console.log(`wrote ${OUT}.kicad_pcb (+ rule files, quads.json)`);
