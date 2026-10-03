// A negotiated-congestion grid router (PathFinder) over every copper layer,
// for the two problems the stamp pipeline could never state:
//
//   * the PERIODIC stamp as a TORUS -- the quad lattice's fundamental rectangle
//     with wrap-around indexing, so a net's copper and every periodic image of
//     every other net are the same occupancy cells. Tiling is not checked
//     after the fact, it is the topology of the search space;
//   * a plain WINDOW of the real board (rim quads, board-level nets), where
//     nothing wraps and the outline is an obstacle.
//
// Unlike the lanegen A* (sequential, first-come copper frozen, hand guides),
// every net here may be ripped up and re-routed until no two nets want the
// same cell. Clearance is exact at the grid nodes: a cell is closed to a net
// when a FOREIGN copper edge is within clearance + half a track of the node,
// measured against the real primitive, never a raster of it.
//
// Units: board millimetres, KiCad file frame (y down). Node (l, i, j) sits at
// (x0 + i*hx, y0 + j*hy) on layer l.

export const RULE = {
  clr: 0.09,            // copper-copper
  track: 0.1,           // routed track width
  viaDia: 0.5,
  viaDrill: 0.23,
  edge: 0.2,            // copper to board edge
  safe: 0.003,          // grid slack: a segment between two legal nodes dips < 1.2 um
};

const BLOCK = 255;      // stat value: closed to every net

export class GridRouter {
  constructor({ x0, y0, nx, ny, hx, hy, wrap, layers }) {
    Object.assign(this, { x0, y0, nx, ny, hx, hy, wrap: !!wrap, layers });
    this.L = layers.length;
    this.nxy = nx * ny;
    this.N = this.L * this.nxy;
    this.stat = new Uint8Array(this.N);          // 0 free, BLOCK, else owning class
    this.viaStat = new Uint8Array(this.nxy);     // 1 = no new via may be centred here
    // via centres closed by a routed/fixed TRACK: its own net may still drop a
    // via onto it (owner class), everyone else may not
    this.viaOwn = new Uint8Array(this.nxy);
    this.viaCells = new Set();                   // cells holding a pin barrel's centre
    // class whose own static COPPER holds a track centred on this node entirely
    // (a pad or barrel shrunk by half a track): such a node adds no copper, so
    // it neither claims clearance nor can be in conflict
    this.core = new Uint8Array(this.N);
    this.occT = new Uint8Array(this.N);          // # nets whose copper closes this node to a track
    this.occV = new Uint8Array(this.nxy);        // # nets whose copper closes this cell to a via
    this.hist = new Float32Array(this.N);
    this.histV = new Float32Array(this.nxy);
    this.g = new Float64Array(this.N);
    this.par = new Int32Array(this.N);
    this.pdir = new Uint8Array(this.N);
    this.seen = new Uint32Array(this.N);
    this.closed = new Uint32Array(this.N);
    this.tgt = new Uint32Array(this.N);
    this.gen = 0;
    this.markT = new Uint32Array(this.N);
    this.markV = new Uint32Array(this.nxy);
    this.mgen = 0;
    this.nets = [];
    this.classes = new Map();                    // name -> id (1..254)
    this.layerCost = layers.map(() => 1);
    this.viaCost = 50;                           // in cell-steps
    this.turnCost = 0.4;
    this.astarW = 1.15;
    const h = Math.max(hx, hy);
    const disc = (r) => {
      const o = [];
      const ri = Math.ceil(r / hx), rj = Math.ceil(r / hy);
      for (let dj = -rj; dj <= rj; dj++) for (let di = -ri; di <= ri; di++) {
        if ((di * hx) ** 2 + (dj * hy) ** 2 < r * r) o.push(di, dj);
      }
      return Int32Array.from(o);
    };
    const { clr, track, viaDia, safe } = RULE;
    this.dTT = disc(track + clr + safe);                 // track centre vs foreign track centre
    this.dTV = disc(track / 2 + clr + viaDia / 2 + safe); // track centre vs foreign via centre
    this.dVV = disc(viaDia + clr + safe);                // via centre vs foreign via centre
    this.h = h;
  }

  cls(name) {
    if (!this.classes.has(name)) {
      if (this.classes.size >= 253) throw new Error('too many net classes');
      this.classes.set(name, this.classes.size + 1);
    }
    return this.classes.get(name);
  }

  // ---- index helpers ---------------------------------------------------------
  ix(x) { return Math.round((x - this.x0) / this.hx); }
  jy(y) { return Math.round((y - this.y0) / this.hy); }
  cell(iu, ju) {                                  // unwrapped ints -> cell index or -1
    if (this.wrap) {
      const i = ((iu % this.nx) + this.nx) % this.nx, j = ((ju % this.ny) + this.ny) % this.ny;
      return j * this.nx + i;
    }
    if (iu < 0 || ju < 0 || iu >= this.nx || ju >= this.ny) return -1;
    return ju * this.nx + iu;
  }

  // ---- rasterisers: call cb(cell) for every node within r of the primitive ----
  _row(j, ia, ib, cb) {
    if (this.wrap) {
      const jw = ((j % this.ny) + this.ny) % this.ny, base = jw * this.nx;
      if (ib - ia >= this.nx) { for (let i = 0; i < this.nx; i++) cb(base + i); return; }
      for (let i = ia; i <= ib; i++) cb(base + (((i % this.nx) + this.nx) % this.nx));
    } else {
      if (j < 0 || j >= this.ny) return;
      const a = Math.max(0, ia), b = Math.min(this.nx - 1, ib), base = j * this.nx;
      for (let i = a; i <= b; i++) cb(base + i);
    }
  }
  rasterDisc(cx, cy, r, cb) {
    const { x0, y0, hx, hy } = this;
    const j0 = Math.ceil((cy - r - y0) / hy), j1 = Math.floor((cy + r - y0) / hy);
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + j * hy - cy, w2 = r * r - dy * dy;
      if (w2 < 0) continue;
      const w = Math.sqrt(w2);
      this._row(j, Math.ceil((cx - w - x0) / hx), Math.floor((cx + w - x0) / hx), cb);
    }
  }
  rasterCapsule(ax, ay, bx, by, r, cb) {
    const { x0, y0, hx, hy } = this;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) { this.rasterDisc(ax, ay, r, cb); return; }
    const nxn = -(by - ay) / len * r, nyn = (bx - ax) / len * r;
    const P = [[ax + nxn, ay + nyn], [bx + nxn, by + nyn], [bx - nxn, by - nyn], [ax - nxn, ay - nyn]];
    const j0 = Math.ceil((Math.min(ay, by) - r - y0) / hy), j1 = Math.floor((Math.max(ay, by) + r - y0) / hy);
    for (let j = j0; j <= j1; j++) {
      const y = y0 + j * hy;
      let lo = Infinity, hi = -Infinity;
      for (const [cx, cy] of [[ax, ay], [bx, by]]) {
        const w2 = r * r - (y - cy) ** 2;
        if (w2 >= 0) { const w = Math.sqrt(w2); lo = Math.min(lo, cx - w); hi = Math.max(hi, cx + w); }
      }
      for (let k = 0; k < 4; k++) {
        const p = P[k], q = P[(k + 1) & 3];
        if ((p[1] - y) * (q[1] - y) > 0) continue;
        if (Math.abs(p[1] - q[1]) < 1e-12) { lo = Math.min(lo, p[0], q[0]); hi = Math.max(hi, p[0], q[0]); continue; }
        const x = p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]);
        lo = Math.min(lo, x); hi = Math.max(hi, x);
      }
      if (hi >= lo) this._row(j, Math.ceil((lo - x0) / hx), Math.floor((hi - x0) / hx), cb);
    }
  }
  // rect w x h centred (cx, cy), rotated `deg` in KiCad's sense (CCW seen
  // y-up, so the file's y-down frame negates it), grown by r with round corners
  rasterRect(cx, cy, w, h, deg, r, cb) {
    const { x0, y0, hx, hy } = this;
    const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const R = Math.hypot(w / 2, h / 2) + r;
    const j0 = Math.ceil((cy - R - y0) / hy), j1 = Math.floor((cy + R - y0) / hy);
    const i0 = Math.ceil((cx - R - x0) / hx), i1 = Math.floor((cx + R - x0) / hx);
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + j * hy - cy;
      let ia = null, ib = null;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + i * hx - cx;
        const lx = dx * ca - dy * sa, ly = dx * sa + dy * ca;
        const qx = Math.max(Math.abs(lx) - w / 2, 0), qy = Math.max(Math.abs(ly) - h / 2, 0);
        if (qx * qx + qy * qy <= r * r) { if (ia === null) ia = i; ib = i; }
      }
      if (ia !== null) this._row(j, ia, ib, cb);     // convex: one interval per row
    }
  }

  // ---- static copper -----------------------------------------------------------
  // owner: class id that may still use the cell, or BLOCK. Two different owners
  // wanting one cell close it to both.
  _own(arr, base, owner) {
    return (c) => {
      const v = arr[base + c];
      if (v === 0) arr[base + c] = owner; else if (v !== owner) arr[base + c] = BLOCK;
    };
  }
  /** A static primitive on one routing layer (or all, layer = -1).
   *  shape: {t:'disc',x,y,r} | {t:'seg',ax,ay,bx,by,r} | {t:'rect',x,y,w,h,deg}
   *  where r is the primitive's own half-width / radius. */
  addStatic(layer, shape, owner, { viaOnly = false, clr = RULE.clr, track = false } = {}) {
    const grow = clr + RULE.track / 2 + RULE.safe;
    const growV = clr + RULE.viaDia / 2 + RULE.safe;
    const run = (g, cb) => {
      if (shape.t === 'disc') this.rasterDisc(shape.x, shape.y, shape.r + g, cb);
      else if (shape.t === 'seg') this.rasterCapsule(shape.ax, shape.ay, shape.bx, shape.by, shape.r + g, cb);
      else this.rasterRect(shape.x, shape.y, shape.w, shape.h, shape.deg, g, cb);
    };
    if (!viaOnly) {
      const ls = layer < 0 ? this.layers.map((_, k) => k) : [layer];
      for (const l of ls) run(grow, this._own(this.stat, l * this.nxy, owner));
    }
    const vs = this.viaStat;
    if (track && owner !== BLOCK) run(growV, this._own(this.viaOwn, 0, owner));
    else run(growV, (c) => { vs[c] = 1; });
    if (!viaOnly && owner !== BLOCK && shape.t !== 'seg') {
      const ht = RULE.track / 2, core = this.core;
      const ls = layer < 0 ? this.layers.map((_, k) => k) : [layer];
      for (const l of ls) {
        const base = l * this.nxy, cb = (c) => { core[base + c] = owner; };
        if (shape.t === 'disc') this.rasterDisc(shape.x, shape.y, shape.r - ht, cb);
        else this.rasterRect(shape.x, shape.y, shape.w - 2 * ht, shape.h - 2 * ht, shape.deg, 0, cb);
      }
    }
  }

  // ---- nets --------------------------------------------------------------------
  /** net: { name, cls, allow:[cls ids], groups:[{name, nodes:[[l,iu,ju],...]}],
   *         jobs:[{from:'tree'|[groupIdx], to:groupIdx, cut?}], tree:[groupIdx],
   *         cut?: {i0,ilen,j0,jlen} }  -- cut strips are FORBIDDEN wrapped ranges. */
  addNet(net) {
    const allow = new Uint8Array(256);
    for (const c of [net.cls, ...(net.allow || [])]) allow[c] = 1;
    net.allowMask = allow;
    net.id = this.nets.length;
    net.paths = [];            // routed: {nodes:Int32Array, unw:Int32Array(2n)}
    net.stT = null; net.stV = null;
    this.nets.push(net);
    return net;
  }

  _cutMasks(cut) {
    const cx = new Uint8Array(this.nx), cy = new Uint8Array(this.ny);
    if (cut) {
      for (let k = 0; k < (cut.ilen || 0); k++) cx[(((cut.i0 + k) % this.nx) + this.nx) % this.nx] = 1;
      for (let k = 0; k < (cut.jlen || 0); k++) cy[(((cut.j0 + k) % this.ny) + this.ny) % this.ny] = 1;
    }
    return [cx, cy];
  }

  ripup(net) {
    if (net.stT) { const o = this.occT; for (let k = 0; k < net.stT.length; k++) o[net.stT[k]]--; }
    if (net.stV) { const o = this.occV; for (let k = 0; k < net.stV.length; k++) o[net.stV[k]]--; }
    net.stT = net.stV = null;
    net.paths = [];
  }

  /** occupancy of a routed net: closes cells around its copper to OTHER nets.
   *  Cells already inside one of the net's own static zones are skipped --
   *  every foreign net is statically shut out there, and nets that share a
   *  static terminal (the DATA seam via) must be able to meet on it. */
  stamp(net) {
    const { nx, ny, nxy, L, stat, wrap } = this;
    const mg = ++this.mgen, mT = this.markT, mV = this.markV;
    const outT = [], outV = [];
    const allow = net.allowMask, core = this.core;
    const put = (l, i, j, offs) => {
      const base = l * nxy;
      for (let k = 0; k < offs.length; k += 2) {
        let ii = i + offs[k], jj = j + offs[k + 1];
        if (wrap) { ii = ((ii % nx) + nx) % nx; jj = ((jj % ny) + ny) % ny; }
        else if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const n = base + jj * nx + ii;
        if (mT[n] === mg) continue;
        mT[n] = mg;
        const s = stat[n];
        if (s !== 0 && s !== BLOCK && allow[s]) continue;
        outT.push(n);
      }
    };
    const putV = (i, j, offs) => {
      for (let k = 0; k < offs.length; k += 2) {
        let ii = i + offs[k], jj = j + offs[k + 1];
        if (wrap) { ii = ((ii % nx) + nx) % nx; jj = ((jj % ny) + ny) % ny; }
        else if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const c = jj * nx + ii;
        if (mV[c] === mg) continue;
        mV[c] = mg; outV.push(c);
      }
    };
    for (const p of net.paths) {
      const nd = p.nodes;
      for (let k = 0; k < nd.length; k++) {
        const n = nd[k], l = (n / nxy) | 0, c = n - l * nxy, j = (c / nx) | 0, i = c - j * nx;
        if (!(core[n] && allow[core[n]])) {
          put(l, i, j, this.dTT);
          putV(i, j, this.dTV);
        }
        if (k > 0 && p.via[k]) {                   // a NEW via between nd[k-1] and nd[k]
          for (let l2 = 0; l2 < L; l2++) put(l2, i, j, this.dTV);
          putV(i, j, this.dVV);
        }
      }
    }
    net.stT = Int32Array.from(outT); net.stV = Int32Array.from(outV);
    const oT = this.occT, oV = this.occV;
    for (let k = 0; k < net.stT.length; k++) oT[net.stT[k]]++;
    for (let k = 0; k < net.stV.length; k++) oV[net.stV[k]]++;
  }

  /** nodes of this net's routed copper that sit in another net's exclusion */
  conflicts(net) {
    const { nxy, core } = this, bad = [], allow = net.allowMask;
    // the net's own claim is in the counts: take it out while looking
    if (net.stT) for (let k = 0; k < net.stT.length; k++) this.occT[net.stT[k]]--;
    if (net.stV) for (let k = 0; k < net.stV.length; k++) this.occV[net.stV[k]]--;
    for (const p of net.paths) {
      for (let k = 0; k < p.nodes.length; k++) {
        const n = p.nodes[k];
        if (this.occT[n] > 0 && !(core[n] && allow[core[n]])) bad.push(n);
        if (k > 0 && p.via[k] && this.occV[n % nxy] > 0) { bad.push(n); this.histV[n % nxy] += this.histStep; }
      }
    }
    if (net.stT) for (let k = 0; k < net.stT.length; k++) this.occT[net.stT[k]]++;
    if (net.stV) for (let k = 0; k < net.stV.length; k++) this.occV[net.stV[k]]++;
    return bad;
  }

  // ---- A* ------------------------------------------------------------------------
  /** sources: array of [node, iu, ju]; targets: array of node ids.
   *  Returns {nodes, unw, via} from a source to a target, or null. */
  search(net, sources, targets, cut, pf, hard, layerCost, ownVias = []) {
    const { nx, ny, nxy, L, stat, occT, occV, hist, histV, viaStat, wrap, g, par, pdir, seen, closed, tgt, core, viaOwn } = this;
    const gen = ++this.gen;
    const allow = net.allowMask;
    const [cutX, cutY] = this._cutMasks(cut);
    // target bbox in a frame unwrapped around the first target
    let ti0 = 1e9, ti1 = -1e9, tj0 = 1e9, tj1 = -1e9;
    const t0 = targets[0] % nxy, tI = t0 % nx, tJ = (t0 / nx) | 0;
    const rel = (d, n) => (wrap ? (((d + (n >> 1)) % n) + n) % n - (n >> 1) : d);
    for (const t of targets) {
      tgt[t] = gen;
      const c = t % nxy, i = c % nx, j = (c / nx) | 0;
      const di = rel(i - tI, nx), dj = rel(j - tJ, ny);
      if (di < ti0) ti0 = di; if (di > ti1) ti1 = di; if (dj < tj0) tj0 = dj; if (dj > tj1) tj1 = dj;
    }
    const W = this.astarW;
    const hOf = (i, j) => {
      let di = rel(i - tI, nx), dj = rel(j - tJ, ny);
      di = di < ti0 ? ti0 - di : di > ti1 ? di - ti1 : 0;
      dj = dj < tj0 ? tj0 - dj : dj > tj1 ? dj - tj1 : 0;
      return W * (di > dj ? di + 0.41421356 * dj : dj + 0.41421356 * di);
    };
    // binary heap of (f, node)
    let hf = new Float64Array(1 << 16), hn = new Int32Array(1 << 16), hs = 0;
    const push = (f, n) => {
      if (hs === hf.length) { const a = new Float64Array(hs * 2); a.set(hf); hf = a; const b = new Int32Array(hs * 2); b.set(hn); hn = b; }
      let k = hs++;
      while (k > 0) { const p = (k - 1) >> 1; if (hf[p] <= f) break; hf[k] = hf[p]; hn[k] = hn[p]; k = p; }
      hf[k] = f; hn[k] = n;
    };
    const pop = () => {
      const top = hn[0]; hs--;
      if (hs > 0) {
        const f = hf[hs], n = hn[hs]; let k = 0;
        for (;;) {
          let c = 2 * k + 1; if (c >= hs) break;
          if (c + 1 < hs && hf[c + 1] < hf[c]) c++;
          if (hf[c] >= f) break;
          hf[k] = hf[c]; hn[k] = hn[c]; k = c;
        }
        hf[k] = f; hn[k] = n;
      }
      return top;
    };
    for (const [n] of sources) {
      const c = n % nxy, i = c % nx, j = (c / nx) | 0;
      if (cutX[i] || cutY[j]) continue;
      seen[n] = gen; g[n] = 0; par[n] = -1; pdir[n] = 255;
      push(hOf(i, j), n);
    }
    const DI = [1, 1, 0, -1, -1, -1, 0, 1], DJ = [0, 1, 1, 1, 0, -1, -1, -1];
    const DC = [1, 1.41421356, 1, 1.41421356, 1, 1.41421356, 1, 1.41421356];
    const OWN_VV = RULE.viaDrill + 0.2 + 0.03;
    const lc = layerCost || net.layerCost || this.layerCost, VIA = this.viaCost, TURN = this.turnCost, HS = this.histScale ?? 1;
    let found = -1, expanded = 0;
    while (hs > 0) {
      const n = pop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (tgt[n] === gen) { found = n; break; }
      expanded++;
      const l = (n / nxy) | 0, c = n - l * nxy, j = (c / nx) | 0, i = c - j * nx;
      const gn = g[n], pd = pdir[n], base = l * nxy;
      for (let d = 0; d < 8; d++) {
        let ii = i + DI[d], jj = j + DJ[d];
        if (wrap) { if (ii < 0) ii += nx; else if (ii >= nx) ii -= nx; if (jj < 0) jj += ny; else if (jj >= ny) jj -= ny; }
        else if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        if (cutX[ii] || cutY[jj]) continue;
        const m = base + jj * nx + ii;
        if (closed[m] === gen) continue;
        const s = stat[m];
        if (s !== 0 && !allow[s]) continue;
        const o = core[m] && allow[core[m]] ? 0 : occT[m];
        if (o > 0 && hard) continue;
        let cost = (DC[d] * lc[l] + HS * hist[m]) * (1 + pf * o);
        if (pd !== 255 && pd !== d) cost += TURN;
        const ng = gn + cost;
        if (seen[m] !== gen || ng < g[m]) {
          seen[m] = gen; g[m] = ng; par[m] = n; pdir[m] = d;
          push(ng + hOf(ii, jj), m);
        }
      }
      // layer change: a through via at this cell (all layers at once)
      let viaOk = viaStat[c] === 0 && (viaOwn[c] === 0 || allow[viaOwn[c]]);
      // the net's OWN new vias: lands may merge, holes may not crowd (0.2 mm
      // hole-to-hole) -- same net, so no clearance rule and no occupancy sees it
      for (let q = 0; viaOk && q < ownVias.length; q += 2) {
        let di = i - ownVias[q], dj = j - ownVias[q + 1];
        if (wrap) { di = rel(di, nx); dj = rel(dj, ny); }
        if ((di || dj) && Math.hypot(di * this.hx, dj * this.hy) < OWN_VV) viaOk = false;
      }
      if (viaOk) {
        const ov = occV[c];
        if (!(ov > 0 && hard)) {
          const vc = (VIA + HS * histV[c]) * (1 + pf * ov);
          for (let l2 = 0; l2 < L; l2++) {
            if (l2 === l) continue;
            const m = l2 * nxy + c;
            if (closed[m] === gen) continue;
            const s = stat[m];
            if (s !== 0 && !allow[s]) continue;
            const o = core[m] && allow[core[m]] ? 0 : occT[m];
            if (o > 0 && hard) continue;
            const ng = gn + vc + HS * hist[m] * (1 + pf * o) + pf * o;
            if (seen[m] !== gen || ng < g[m]) {
              seen[m] = gen; g[m] = ng; par[m] = n; pdir[m] = 254;
              push(ng + hOf(i, j), m);
            }
          }
        }
      }
    }
    this.lastExpanded = expanded;
    if (found < 0) return null;
    // backtrack; rebuild unwrapped coordinates from the source's
    const rev = [];
    for (let n = found; n !== -1; n = par[n]) rev.push(n);
    rev.reverse();
    const src = sources.find(([n]) => n === rev[0]);
    const nodes = Int32Array.from(rev), unw = new Int32Array(rev.length * 2), via = new Uint8Array(rev.length);
    let iu = src[1], ju = src[2];
    unw[0] = iu; unw[1] = ju;
    for (let k = 1; k < rev.length; k++) {
      const a = rev[k - 1] % nxy, b = rev[k] % nxy;
      if (a === b) via[k] = 1;
      else {
        let di = (b % nx) - (a % nx), dj = ((b / nx) | 0) - ((a / nx) | 0);
        if (di > 1) di -= nx; else if (di < -1) di += nx;
        if (dj > 1) dj -= ny; else if (dj < -1) dj += ny;
        iu += di; ju += dj;
      }
      unw[2 * k] = iu; unw[2 * k + 1] = ju;
    }
    return { nodes, unw, via };
  }

  /** How many nodes can this net reach from `nodes` through STATIC copper
   *  alone (other nets' routes ignored)? Returns the count if the pocket is
   *  closed before `limit`, else -1 (open). A pin whose pocket is closed can
   *  never be routed, whatever the negotiation does. */
  pocket(net, nodes, limit = 20000) {
    const { nx, ny, nxy, L, stat, viaStat, viaOwn, wrap } = this, allow = net.allowMask;
    const seen = new Set(nodes), q = [...nodes];
    while (q.length && seen.size < limit) {
      const n = q.pop(), l = (n / nxy) | 0, c = n - l * nxy, j = (c / nx) | 0, i = c - j * nx;
      const tryN = (m) => { if (seen.has(m)) return; const s = stat[m]; if (s !== 0 && !allow[s]) return; seen.add(m); q.push(m); };
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        let ii = i + di, jj = j + dj;
        if (wrap) { ii = (ii + nx) % nx; jj = (jj + ny) % ny; } else if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        tryN(l * nxy + jj * nx + ii);
      }
      if (viaStat[c] === 0 && (viaOwn[c] === 0 || allow[viaOwn[c]])) for (let l2 = 0; l2 < L; l2++) if (l2 !== l) tryN(l2 * nxy + c);
    }
    return q.length ? -1 : seen.size;
  }

  /** route every job of one net against the current occupancy of the others */
  routeNet(net, pf, hard = false) {
    const { nxy } = this;
    const node = ([l, iu, ju]) => { const c = this.cell(iu, ju); return c < 0 ? -1 : l * nxy + c; };
    // the growing tree: node -> unwrapped coords
    const tree = new Map();
    const addGroup = (gi) => { for (const p of net.groups[gi].nodes) { const n = node(p); if (n >= 0 && !tree.has(n)) tree.set(n, [p[1], p[2]]); } };
    for (const gi of net.tree || []) addGroup(gi);
    net.failed = [];
    const ownVias = [];
    for (const job of net.jobs) {
      let sources;
      if (job.from === 'tree') sources = [...tree].map(([n, [iu, ju]]) => [n, iu, ju]);
      else {
        sources = [];
        for (const gi of job.from) for (const p of net.groups[gi].nodes) { const n = node(p); if (n >= 0) sources.push([n, p[1], p[2]]); }
      }
      const targets = [];
      for (const p of net.groups[job.to].nodes) { const n = node(p); if (n >= 0) targets.push(n); }
      let r = null;
      for (let attempt = 0; attempt < 4 && targets.length && sources.length; attempt++) {
        r = this.search(net, sources, targets, job.cut || net.cut, pf, hard, job.layerCost, ownVias);
        if (!r) break;
        // two new vias of this one path crowding each other: price the spot, try again
        const mine = [];
        for (let k = 1; k < r.nodes.length; k++) if (r.via[k]) mine.push(r.unw[2 * k], r.unw[2 * k + 1], r.nodes[k] % nxy);
        let clash = -1;
        for (let a = 0; a < mine.length && clash < 0; a += 3) for (let b = a + 3; b < mine.length; b += 3) {
          const d = Math.hypot((mine[a] - mine[b]) * this.hx, (mine[a + 1] - mine[b + 1]) * this.hy);
          if (d > 0 && d < RULE.viaDrill + 0.23) { clash = mine[b + 2]; break; }
        }
        if (clash < 0) break;
        this.histV[clash] += 1e6; r = null;
      }
      if (!r) { net.failed.push(job); continue; }
      for (let k = 1; k < r.nodes.length; k++) if (r.via[k]) { const c = r.nodes[k] % nxy; ownVias.push(c % this.nx, (c / this.nx) | 0); }
      r.job = job;
      net.paths.push(r);
      if (job.join !== false) {
        for (let k = 0; k < r.nodes.length; k++) if (!tree.has(r.nodes[k])) tree.set(r.nodes[k], [r.unw[2 * k], r.unw[2 * k + 1]]);
        addGroup(job.to);
      }
    }
    return net.failed.length === 0;
  }

  /** After convergence: re-route each net alone against everyone else's final
   *  copper, history off -- the negotiated path carries detours around fights
   *  that are over. Keeps the old route unless the new one is complete+legal. */
  polish(rounds = 2, log = console.log) {
    const save = this.histScale;
    this.histScale = 0;
    for (let r = 0; r < rounds; r++) {
      let better = 0;
      for (const net of this.nets) {
        if (!net.jobs.length) continue;
        const old = net.paths, len0 = old.reduce((s, p) => s + p.nodes.length, 0);
        this.ripup(net);
        const ok = this.routeNet(net, 0, true);
        const len1 = net.paths.reduce((s, p) => s + p.nodes.length, 0);
        if (!ok || len1 >= len0) { net.paths = old; net.failed = []; } else better++;
        this.stamp(net);
      }
      log(`polish ${r + 1}: ${better} nets shortened`);
      if (!better) break;
    }
    this.histScale = save;
  }

  /** Replace staircases by two-segment (45 + straight) shortcuts wherever every
   *  node of the shortcut is legal. Path ends, vias and same-net junctions stay. */
  smooth(net) {
    const { nxy, stat, occT, core } = this, allow = net.allowMask;
    if (net.stT) for (let k = 0; k < net.stT.length; k++) occT[net.stT[k]]--;
    if (net.stV) for (let k = 0; k < net.stV.length; k++) this.occV[net.stV[k]]--;
    const anchors = new Set();
    for (const p of net.paths) { anchors.add(p.nodes[0]); anchors.add(p.nodes[p.nodes.length - 1]); }
    let saved = 0;
    for (const p of net.paths) {
      const [cutX, cutY] = this._cutMasks(p.job.cut || net.cut);
      const legal = (l, iu, ju) => {
        const c = this.cell(iu, ju);
        if (c < 0 || cutX[c % this.nx] || cutY[(c / this.nx) | 0]) return -1;
        const n = l * nxy + c, s = stat[n];
        if (s !== 0 && !allow[s]) return -1;
        if (occT[n] > 0 && !(core[n] && allow[core[n]])) return -1;
        return n;
      };
      const N = p.nodes.length, on = [], ou = [], ov = [];
      // a corner 0.29-0.37 mm from the path's own pin barrel starts the next
      // segment on the edge of the land: electrically nothing, but it reads as
      // "copper brushing a via it is not attached to" (coilcheck's weld test)
      const pinEnds = [];
      for (const k of [0, N - 1]) if (this.viaCells.has(p.nodes[k] % nxy)) pinEnds.push([p.unw[2 * k], p.unw[2 * k + 1]]);
      const onRim = (x, y) => pinEnds.some(([a, b]) => { const d = Math.hypot((x - a) * this.hx, (y - b) * this.hy); return d > 0.29 && d < 0.37; });
      const emit = (n, iu, ju, v) => { on.push(n); ou.push(iu, ju); ov.push(v); };
      const tryL = (l, a0, a1, b0, b1, diagFirst) => {
        const di = b0 - a0, dj = b1 - a1, si = Math.sign(di), sj = Math.sign(dj);
        const m = Math.min(Math.abs(di), Math.abs(dj)), r = Math.max(Math.abs(di), Math.abs(dj)) - m;
        const ri = Math.abs(di) > Math.abs(dj) ? si : 0, rj = Math.abs(di) > Math.abs(dj) ? 0 : sj;
        const out = [];
        let x = a0, y = a1;
        if (onRim(b0, b1)) return null;
        if (m > 0 && r > 0 && (diagFirst ? onRim(a0 + m * si, a1 + m * sj) : onRim(a0 + r * ri, a1 + r * rj))) return null;
        for (let k = 0; k < m + r; k++) {
          const diag = diagFirst ? k < m : k >= r;
          if (diag) { x += si; y += sj; } else { x += ri; y += rj; }
          const n = legal(l, x, y);
          if (n < 0) return null;
          out.push(n, x, y);
        }
        return out;
      };
      let k = 0;
      emit(p.nodes[0], p.unw[0], p.unw[1], 0);
      while (k < N - 1) {
        if (p.via[k + 1]) { k++; emit(p.nodes[k], p.unw[2 * k], p.unw[2 * k + 1], 1); continue; }
        // the straight piece this node starts: up to the next via / anchor / end
        let e = k + 1;
        while (e < N - 1 && !p.via[e + 1] && !anchors.has(p.nodes[e])) e++;
        const l = (p.nodes[k] / nxy) | 0;
        let i = k;
        while (i < e) {
          let done = false;
          for (let j = Math.min(e, i + 600); j > i + 1 && !done; j -= (j - i > 40 ? 4 : 1)) {
            for (const df of [true, false]) {
              const L = tryL(l, p.unw[2 * i], p.unw[2 * i + 1], p.unw[2 * j], p.unw[2 * j + 1], df);
              if (!L || L.length / 3 > j - i) continue;
              if (L.length / 3 < j - i) saved += j - i - L.length / 3;
              for (let q = 0; q < L.length; q += 3) emit(L[q], L[q + 1], L[q + 2], 0);
              i = j; done = true; break;
            }
          }
          if (!done) { i++; emit(p.nodes[i], p.unw[2 * i], p.unw[2 * i + 1], 0); }
        }
        k = e;
      }
      p.nodes = Int32Array.from(on); p.unw = Int32Array.from(ou); p.via = Uint8Array.from(ov);
    }
    net.stT = net.stV = null;
    this.stamp(net);
    return saved;
  }

  /** PathFinder: route all, then re-route whoever shares cells until nobody does */
  negotiate({ maxIter = 60, pf0 = 0.6, pfGrow = 1.35, pfMax = 40, histStep = 0.35, seed = 1, kick = 30, log = console.log, onIter } = {}) {
    this.histStep = histStep;
    let pf = pf0;
    // pf is capped: past a point the present-sharing term swamps history and
    // the nets just swap the same conflict back and forth forever. History is
    // what breaks the cycle, so it has to stay visible in the cost.
    let rs = seed >>> 0;
    const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
    const shuffle = (a) => { for (let k = a.length - 1; k > 0; k--) { const q = Math.floor(rnd() * (k + 1)); [a[k], a[q]] = [a[q], a[k]]; } return a; };
    let todo = this.nets.filter((n) => n.jobs.length);
    let best = null, lastGain = 0;
    for (let it = 1; it <= maxIter; it++) {
      const t0 = Date.now();
      for (const net of todo) {
        this.ripup(net);
        this.routeNet(net, pf);
        this.stamp(net);
      }
      let nConf = 0, nFail = 0;
      const again = [];
      for (const net of this.nets) {
        if (!net.jobs.length) continue;
        const bad = this.conflicts(net);
        if (net.failed.length) nFail++;
        if (bad.length || net.failed.length) { again.push(net); }
        if (bad.length) nConf++;
        // History goes on the whole contested REGION, not just the centreline
        // nodes: a track is a resource 2x8 cells wide here, and a net that can
        // dodge its own history by shifting one cell never leaves the fight.
        if (bad.length) {
          const mg = ++this.mgen, mT = this.markT, { nx, ny, nxy, wrap } = this, offs = this.dTT;
          for (const n of bad) {
            const l = (n / nxy) | 0, c = n - l * nxy, j = (c / nx) | 0, i = c - j * nx, base = l * nxy;
            for (let k = 0; k < offs.length; k += 2) {
              let ii = i + offs[k], jj = j + offs[k + 1];
              if (wrap) { ii = ((ii % nx) + nx) % nx; jj = ((jj % ny) + ny) % ny; }
              else if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
              const m = base + jj * nx + ii;
              if (mT[m] !== mg) { mT[m] = mg; this.hist[m] += histStep; }
            }
          }
        }
      }
      log(`iter ${it}: routed ${todo.length} nets, ${nConf} in conflict, ${nFail} with unrouted jobs, pf ${pf.toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`
        + (again.length && again.length <= 12 ? `  [${again.map((n) => n.name + (n.failed.length ? '!' : '')).join(' ')}]` : ''));
      if (onIter) onIter(it, again);
      if (best === null || again.length < best) { best = again.length; lastGain = it; }
      if (again.length === 0) return { ok: true, iters: it };
      todo = it > 3 ? shuffle(again) : again;
      pf = Math.min(pfMax, pf * pfGrow);
      // Stagnation: the same handful swapping one corridor. Start the
      // negotiation over for EVERY net with the sharing price back at its
      // floor -- the history stays, so the fought-over ground is expensive
      // from the first pass and the settled nets get to move off it.
      if (it - lastGain >= kick) {
        todo = shuffle(this.nets.filter((n) => n.jobs.length));
        pf = pf0; lastGain = it; best = null;
        log(`  kick at iter ${it}: re-negotiating all ${todo.length} nets on the accumulated history`);
      }
    }
    return { ok: false, left: todo.map((n) => n.name) };
  }
}

// ---- geometry out ------------------------------------------------------------------
/** A routed net's copper as straight runs + vias, in board mm (unwrapped frame).
 *  exact: Map cell -> [x, y] of a real via/pin centre, so a run that ends on a
 *  barrel's grid node is finished to the barrel's true centre. */
export function netGeometry(R, net, exact = new Map()) {
  const { nxy, nx, hx, hy, x0, y0 } = R;
  const edges = new Map();           // layer -> Map key -> Set of neighbour keys
  const key = (iu, ju) => `${iu},${ju}`;
  const breaks = new Set();          // `${l}|${iu},${ju}`
  const vias = new Map();
  const tails = [];
  for (const p of net.paths) {
    const n = p.nodes.length;
    for (let k = 0; k < n; k++) {
      const l = (p.nodes[k] / nxy) | 0, iu = p.unw[2 * k], ju = p.unw[2 * k + 1];
      if (k === 0 || k === n - 1 || p.via[k] || (k + 1 < n && p.via[k + 1])) breaks.add(`${l}|${key(iu, ju)}`);
      if (k === 0 || k === n - 1) {
        const c = p.nodes[k] % nxy, e = exact.get(c);
        if (e) {
          const ic = c % nx, jc = (c / nx) | 0;
          const ex = e[0] + (iu - ic) * hx, ey = e[1] + (ju - jc) * hy;
          const gx = x0 + iu * hx, gy = y0 + ju * hy;
          if (Math.hypot(ex - gx, ey - gy) > 1e-4) tails.push({ layer: R.layers[l], a: [gx, gy], b: [ex, ey] });
        }
      }
      if (k === 0) continue;
      if (p.via[k]) { vias.set(key(iu, ju), [x0 + iu * hx, y0 + ju * hy]); continue; }
      const pl = (p.nodes[k - 1] / nxy) | 0;
      if (!edges.has(pl)) edges.set(pl, new Map());
      const E = edges.get(pl), a = key(p.unw[2 * k - 2], p.unw[2 * k - 1]), b = key(iu, ju);
      if (!E.has(a)) E.set(a, new Set()); if (!E.has(b)) E.set(b, new Set());
      E.get(a).add(b); E.get(b).add(a);
    }
  }
  const segs = [];
  const xy = (k) => { const [iu, ju] = k.split(',').map(Number); return [iu, ju]; };
  for (const [l, E] of edges) {
    const isBreak = (k) => {
      if (breaks.has(`${l}|${k}`)) return true;
      const nb = [...E.get(k)];
      if (nb.length !== 2) return true;
      const [a, b] = nb.map(xy), [c0, c1] = xy(k);
      return (a[0] - c0) !== (c0 - b[0]) || (a[1] - c1) !== (c1 - b[1]);
    };
    const used = new Set();
    const walk = (s, nb) => {
      let prev = s, cur = nb;
      used.add(`${prev}>${cur}`); used.add(`${cur}>${prev}`);
      while (!isBreak(cur)) {
        const nx2 = [...E.get(cur)].find((q) => q !== prev);
        prev = cur; cur = nx2;
        used.add(`${prev}>${cur}`); used.add(`${cur}>${prev}`);
        if (cur === s) break;
      }
      const [a0, a1] = xy(s), [b0, b1] = xy(cur);
      segs.push({ layer: R.layers[l], a: [x0 + a0 * hx, y0 + a1 * hy], b: [x0 + b0 * hx, y0 + b1 * hy] });
    };
    for (const k of E.keys()) if (isBreak(k)) for (const nb of E.get(k)) if (!used.has(`${k}>${nb}`)) walk(k, nb);
    for (const k of E.keys()) for (const nb of E.get(k)) if (!used.has(`${k}>${nb}`)) walk(k, nb);   // break-free loops
  }
  for (const t of tails) segs.push(t);
  return { segs, vias: [...vias.values()] };
}
