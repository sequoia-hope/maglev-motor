// Build a Specctra .dsn for the ELECTRONICS side of a coil board.
//
// Handing the whole .kicad_pcb to an autorouter does not work: the amzhex board
// is 275 000 track segments of coil spiral, and freerouting spends all its time
// re-deriving that none of it is routable. It is also the wrong description of
// the problem. The coil layers are not a routing resource -- they are eleven
// solid layers of winding whose only effect on the router is that a THROUGH via
// cannot be drilled through them. That is one sentence, and Specctra has a word
// for it: via_keepout.
//
// So this writes the routing problem, not the board:
//   * only the electronics (spare) layers exist, as signal layers;
//   * every pad on those layers is a single-pin component, already rotated, so
//     no image/rotation composition can go wrong;
//   * every coil is one hexagonal via_keepout -- a routing via may not be
//     drilled where the winding is -- which leaves exactly the gutter lattice
//     and nothing else, which is the physical truth;
//   * every existing crossover via is a keepout circle: real copper on the
//     electronics layers, on the coil's net, that the router must not touch.
//     The two TERMINAL vias per coil are omitted, because their land is the
//     coil's I/O pad, which is present as a pad and is where the bridge output
//     is supposed to arrive.
//
// The .ses that comes back is merged into the full board by mkses.mjs, and the
// full board is what gets DRC'd -- the proxy is only ever an input.

import { readFileSync, writeFileSync } from 'fs';

const um = (mm) => Math.round(mm * 1000);

/** Pull the parts of a generated .kicad_pcb this needs. The file is machine
 *  written and utterly regular, so these patterns are exact, not heuristic. */
export function readBoard(path) {
  const txt = readFileSync(path, 'utf8');
  const outline = [];
  for (const m of txt.matchAll(/\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)/g)) {
    outline.push([+m[1], +m[2], +m[3], +m[4]]);
  }
  const vias = [];
  for (const m of txt.matchAll(/\(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill ([\d.]+)\) \(layers "[^"]+" "[^"]+"\) \(net (\d+)\)\)/g)) {
    vias.push({ x: +m[1], y: +m[2], size: +m[3], drill: +m[4], net: +m[5] });
  }
  const nets = new Map();                        // num -> name
  for (const m of txt.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) nets.set(+m[1], m[2]);
  // Tracks already on the board, so a partly-routed board can be handed back
  // for another go instead of starting from nothing. Only the ones a router
  // could have put there: the spiral is arcs and 0.103 mm segments in their
  // thousands, and it belongs to the coil, not to the routing problem.
  const tracks = [];
  for (const m of txt.matchAll(/\(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\) \(layer "([^"]+)"\) \(net (\d+)\)\)/g)) {
    tracks.push({
      a: [+m[1], +m[2]], b: [+m[3], +m[4]], width: +m[5], layer: m[6], net: +m[7],
    });
  }

  const fps = [];
  const fpRe = /\(footprint "maglev:([^"]+)" \(layer "([^"]+)"\) \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)([\s\S]*?)\n  \)/g;
  for (const m of txt.matchAll(fpRe)) {
    const body = m[6];
    const ref = (body.match(/\(fp_text reference "([^"]+)"/) || [])[1] || '?';
    const pads = [];
    for (const p of body.matchAll(/\(pad "([^"]+)" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\) \(layers "([^"]+)"[^)]*\)(?: \(clearance ([\d.]+)\))? \(net (\d+) "([^"]*)"\)\)/g)) {
      pads.push({
        name: p[1], dx: +p[2], dy: +p[3], ang: +(p[4] || 0),
        w: +p[5], h: +p[6], layer: p[7], clr: p[8] ? +p[8] : 0,
        net: +p[9], netName: p[10],
      });
    }
    fps.push({ lib: m[1], layer: m[2], x: +m[3], y: +m[4], rot: +(m[5] || 0), ref, pads });
  }
  return { txt, outline, vias, nets, fps, tracks };
}

/** Offset a simple closed polygon inward by `d`: offset each edge along its
 *  inward normal and intersect consecutive offset lines. Freerouting keeps
 *  copper a CLEARANCE off the boundary, but the fab wants an EDGE clearance,
 *  which is more -- so the router is handed a boundary that is already pulled
 *  in by the difference, and its own rule does the rest. Without this its
 *  output sat 0.17 mm off a 0.2 mm edge. */
function offsetPoly(loop, d) {
  const n = loop.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area > 0 ? 1 : -1;                 // CCW -> inward normal is left
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const L = Math.hypot(ex, ey) || 1;
    const nx = (-ey / L) * sgn, ny = (ex / L) * sgn;
    lines.push([a[0] + nx * d, a[1] + ny * d, ex / L, ey / L]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const [px, py, ux, uy] = lines[(i - 1 + n) % n];
    const [qx, qy, vx, vy] = lines[i];
    const den = ux * vy - uy * vx;
    if (Math.abs(den) < 1e-9) { out.push([qx, qy]); continue; }
    const t = ((qx - px) * vy - (qy - py) * vx) / den;
    out.push([px + ux * t, py + uy * t]);
  }
  return out;
}

/** Chain the Edge.Cuts segments into one closed loop of points. */
function outlineLoop(segs) {
  const key = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
  const next = new Map();
  for (const [x0, y0, x1, y1] of segs) next.set(key(x0, y0), [x1, y1]);
  const start = [segs[0][0], segs[0][1]];
  const loop = [start];
  let cur = start;
  for (let i = 0; i < segs.length; i++) {
    const n = next.get(key(cur[0], cur[1]));
    if (!n) break;
    if (Math.abs(n[0] - start[0]) < 1e-6 && Math.abs(n[1] - start[1]) < 1e-6) break;
    loop.push(n); cur = n;
  }
  return loop;
}

export function writeDsn(board, opts) {
  const {
    name, layers, rule, via, coils, coilKeepR, keepVias, out,
  } = opts;
  const L = [];
  const p = (s) => L.push(s);
  // DSN is y-up, KiCad files are y-down.
  const X = (v) => um(v), Y = (v) => -um(v);

  p(`(pcb ${name}`);
  p('  (parser');
  p('    (string_quote ")');
  p('    (space_in_quoted_tokens on)');
  p('    (host_cad "maglev-sim")');
  p('    (host_version "1")');
  p('  )');
  p('  (resolution um 10)');
  p('  (unit um)');
  p('  (structure');
  layers.forEach((ln, i) => {
    p(`    (layer ${ln}`);
    p('      (type signal)');
    p(`      (property (index ${i}))`);
    p('    )');
  });
  const raw = outlineLoop(board.outline);
  const loop = rule.edge > rule.clearance ? offsetPoly(raw, rule.edge - rule.clearance) : raw;
  p(`    (boundary (path pcb 0 ${loop.map(([x, y]) => `${X(x)} ${Y(y)}`).join('  ')}  ${X(loop[0][0])} ${Y(loop[0][1])}))`);
  p(`    (via "${via.name}")`);
  p('    (rule');
  p(`      (width ${um(rule.width)})`);
  p(`      (clearance ${um(rule.clearance)})`);
  p(`      (clearance ${um(rule.clearance)} (type wire_via))`);
  p(`      (clearance ${um(rule.clearance)} (type via_via))`);
  p(`      (clearance ${um(rule.clearance)} (type smd_via))`);
  p(`      (clearance ${um(rule.clearance)} (type smd_smd))`);
  p('    )');
  // Keepout areas are grown by a clearance HERE, because freerouting does not
  // apply the clearance rule to them: it keeps only the routed item's own
  // half-width outside a keepout. Left ungrown, a track ran 0.062 mm from a
  // crossover via that the rules say needs 0.09 -- the keepout was doing its
  // job, it was just exactly the wrong size by exactly one clearance.
  const grow = rule.clearance;
  // Where a through via may NOT be drilled: into the winding. That is an
  // ANNULUS, not a disc -- the coil's centre hole is copper-free on every
  // winding layer, so a hole big enough to hold one is a legal via site right
  // under the part that needs it. Blocking it (which one solid hexagon per coil
  // did) throws away the only interior via site the topology offers.
  // Specctra polygons have no holes, so the ring is emitted as six trapezoids,
  // one per hexagon flat.
  let nk = 0;
  const hexPt = (c, R, k) => {
    const a = (k * Math.PI) / 3 + Math.PI / 6;
    return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
  };
  const cos30 = Math.cos(Math.PI / 6);
  for (const c of (opts.noKeepout ? [] : coils)) {
    const Ro = (coilKeepR + grow) / cos30;
    const Ri = Math.max(0, (opts.coilHoleR ?? 0) - grow) / cos30;
    for (let k = 0; k < 6; k++) {
      const q = Ri > 0
        ? [hexPt(c, Ri, k), hexPt(c, Ro, k), hexPt(c, Ro, k + 1), hexPt(c, Ri, k + 1)]
        : [c, hexPt(c, Ro, k), hexPt(c, Ro, k + 1)];
      q.push(q[0]);
      for (const ln of layers) {
        p(`    (via_keepout "coil${nk}_${k}_${ln}" (polygon ${ln} 0 ${q.map(([x, y]) => `${X(x)} ${Y(y)}`).join('  ')}))`);
      }
      if (Ri <= 0) break;                        // a disc needs all six wedges
    }
    if (Ri <= 0) {
      for (let k = 1; k < 6; k++) {
        const q = [c, hexPt(c, Ro, k), hexPt(c, Ro, k + 1), c];
        for (const ln of layers) {
          p(`    (via_keepout "coil${nk}_${k}_${ln}" (polygon ${ln} 0 ${q.map(([x, y]) => `${X(x)} ${Y(y)}`).join('  ')}))`);
        }
      }
    }
    nk++;
  }
  // The crossover and terminal STUBS: the short radial tabs that carry each
  // layer's end out to its via. They live on WINDING layers, so a trace on the
  // electronics side may pass over them freely -- but a through via drilled into
  // one shorts that coil to whatever the via carries. They are not part of the
  // winding hexagon (they stick out past it, into the gutter), so without this
  // the router drills straight through them: the first routed tile came back
  // with an RCLK via welded to coil_4 on In5 and In6.
  for (const st of (opts.blind ? [] : opts.stubs || [])) {
    const [x0, y0, x1, y1, wdt] = st;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const hw = wdt / 2 + grow;
    const hx = -uy * hw, hy = ux * hw;
    const ax = x0 - ux * grow, ay = y0 - uy * grow;   // extend the ends too
    const bx = x1 + ux * grow, by = y1 + uy * grow;
    const q = [
      [ax - hx, ay - hy], [bx - hx, by - hy], [bx + hx, by + hy], [ax + hx, ay + hy],
    ];
    q.push(q[0]);
    for (const ln of layers) {
      p(`    (via_keepout "stub${nk}_${ln}" (polygon ${ln} 0 ${q.map(([x, y]) => `${X(x)} ${Y(y)}`).join('  ')}))`);
    }
    nk++;
  }
  // Existing crossover vias: real copper on EVERY electronics layer.
  (opts.noXVia ? [] : keepVias).forEach((v, i) => {
    for (const ln of layers) {
      p(`    (keepout "xv${i}_${ln}" (circle ${ln} ${um(v.size + 2 * grow)} ${X(v.x)} ${Y(v.y)}))`);
    }
  });
  // The two TERMINAL vias per coil are represented by the coil's I/O pad, which
  // is what the bridge output is meant to land on -- but that pad is on B.Cu
  // alone, while the via it sits on is a plated THROUGH hole with a land on
  // every layer in the stack. Without a keepout on the other electronics
  // layers, an inner-layer track runs straight over it and shorts the coil:
  // that is exactly how RCLK ended up welded to coil_4 on In10.
  (opts.termVias || []).forEach((v, i) => {
    for (const ln of layers) {
      if (ln === opts.padLayer) continue;         // the pad already guards this one
      p(`    (keepout "tv${i}_${ln}" (circle ${ln} ${um(v.size + 2 * grow)} ${X(v.x)} ${Y(v.y)}))`);
    }
  });
  p('  )');

  // --- one single-pin component per pad -------------------------------------
  // Every pad is emitted at its absolute position with its rotation already
  // baked into a polygon padstack. Nothing about footprint origins, mirroring
  // or angle conventions can then be got wrong between here and the board.
  const stacks = new Map();
  const parts = [];
  const skip = new Set(opts.skipLibs || []);
  for (const fp of board.fps) {
    if (skip.has(fp.lib)) continue;
    for (const pd of fp.pads) {
      if (!layers.includes(pd.layer)) continue;
      // Pad angles in a .kicad_pcb are CCW in the Y-UP sense, and DSN is y-up,
      // so the shape is built directly in DSN space and NOT y-flipped again.
      // Rotating in the file's y-down frame and then flipping y mirrors the
      // pad -- which is invisible on a square pad and fatal on the registers'
      // 0.8 x 0.3 pads at 30 degrees: they overlapped each other in the
      // router's view, and every net touching a register came back unrouted.
      const a = ((fp.rot + pd.ang) * Math.PI) / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = fp.x + pd.dx, py = fp.y + pd.dy;
      // The padstack is keyed by layer as well as shape: an SMD pad exists on
      // ONE copper layer, and a padstack that claimed every routing layer would
      // quietly plant phantom copper on the others.
      const key = `${pd.layer}|${pd.w.toFixed(3)}x${pd.h.toFixed(3)}@${(((fp.rot + pd.ang) % 360) + 360) % 360}`;
      if (!stacks.has(key)) {
        const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [
          (sx * pd.w / 2) * ca - (sy * pd.h / 2) * sa,
          (sx * pd.w / 2) * sa + (sy * pd.h / 2) * ca,
        ]);
        c.push(c[0]);
        stacks.set(key, { id: `PS${stacks.size}`, pts: c, layer: pd.layer });
      }
      const ov = opts.netOverride && opts.netOverride.get(`${fp.ref}|${pd.name}`);
      parts.push({
        ref: `${fp.ref}_${pd.name}`.replace(/[\s()"-]/g, '_'),
        img: stacks.get(key).id, x: px, y: py, net: ov || pd.netName,
      });
    }
  }
  p('  (placement');
  for (const s of stacks.values()) {
    p(`    (component IMG_${s.id}`);
    for (const pt of parts) {
      if (pt.img !== s.id) continue;
      p(`      (place ${pt.ref} ${X(pt.x)} ${Y(pt.y)} front 0)`);
    }
    p('    )');
  }
  p('  )');
  p('  (library');
  for (const s of stacks.values()) {
    p(`    (image IMG_${s.id}`);
    p(`      (pin ${s.id} 1 0 0)`);
    p('    )');
  }
  for (const s of stacks.values()) {
    p(`    (padstack ${s.id}`);
    p(`      (shape (polygon ${s.layer} 0 ${s.pts.map(([x, y]) => `${um(x)} ${um(y)}`).join('  ')}))`);
    p('      (attach off)');
    p('    )');
  }
  // The routing via.
  p(`    (padstack "${via.name}"`);
  for (const ln of layers) p(`      (shape (circle ${ln} ${um(via.dia)}))`);
  p('      (attach off)');
  p('    )');
  p('  )');

  // --- netlist ---------------------------------------------------------------
  const byNet = new Map();
  const planes = new Set(opts.planeNets || []);
  const only = opts.onlyNets && opts.onlyNets.length ? new RegExp(opts.onlyNets.join('|')) : null;
  for (const pt of parts) {
    if (!pt.net || planes.has(pt.net)) continue;   // poured, not routed
    if (only && !only.test(pt.net)) continue;
    if (!byNet.has(pt.net)) byNet.set(pt.net, []);
    byNet.get(pt.net).push(`${pt.ref}-1`);
  }
  p('  (network');
  const netNames = [];
  for (const [n, pins] of byNet) {
    if (pins.length < 2) continue;                // nothing to connect
    netNames.push(n);
    p(`    (net ${n}`);
    p(`      (pins ${pins.join(' ')})`);
    p('    )');
  }
  p('    (class default');
  for (const n of netNames) p(`      ${n}`);
  p(`      (circuit (use_via "${via.name}"))`);
  p('      (rule');
  p(`        (width ${um(rule.width)})`);
  p(`        (clearance ${um(rule.clearance)})`);
  p('      )');
  p('    )');
  p('  )');
  p('  (wiring');
  // Pre-routed local nets, FIXED: the router may neither move nor rip them up.
  for (const t of opts.prewired || []) {
    const path = t.pts.map(([x, y]) => `${X(x)} ${Y(y)}`).join('  ');
    p(`    (wire (path ${t.layer} ${um(t.width)} ${path}) (net ${t.net}) (type protect))`);
  }
  // Wiring carried over from a previous run: NOT protected, so the router may
  // rip it up and improve on it. This is what makes a long route resumable --
  // the full board is still gaining ~70 connections a pass when a run ends.
  // A carried track has the BOARD's net name, and the board calls both halves
  // of a coil `coil_i` while the router is given `coil_i_A` / `coil_i_B`. There
  // is no way to tell from the copper which half a carried coil track belonged
  // to, so those are simply dropped -- there are only two per cell and the
  // router redoes them cheaply. Anything else whose net the router does not
  // know about goes the same way rather than referencing a net that is not there.
  let carriedOut = 0;
  const known = new Set(netNames);
  for (const t of opts.carried || []) {
    if (!known.has(t.net)) continue;
    p(`    (wire (path ${t.layer} ${um(t.width)} ${X(t.a[0])} ${Y(t.a[1])}  ${X(t.b[0])} ${Y(t.b[1])}) (net ${t.net}))`);
    carriedOut++;
  }
  p('  )');
  p(')');
  writeFileSync(out, L.join('\n') + '\n');
  return { pads: parts.length, nets: netNames.length, padstacks: stacks.size, keepouts: nk, carried: carriedOut };
}
