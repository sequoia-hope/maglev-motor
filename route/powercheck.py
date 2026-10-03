#!/usr/bin/env python3
"""DC check of the power copper, straight from the board file.

  powercheck.py <board.kicad_pcb> [out.json]

Builds a resistor network from every VBUS and GND track, via barrel, pad and
filled zone on the board, feeds it at the header's power pins, loads every
bridge's supply pins, and solves it. Reports

  * the supply-loop resistance seen by each bridge (VBUS path + GND path),
    which is load-independent and is what a 10 ohm coil is in series with;
  * the worst rail drop and the worst copper current density under two loads:
    HOVER (the simulator's worst-case hover power, spread over every bridge)
    and PEAK (every bridge at the same share of the header pin's rating);
  * the worst single conductor, by name, so a neck is found rather than guessed.

Connectivity is geometric (copper that overlaps is joined), and the script
refuses to report if any bridge supply pin is not reachable from the header:
the board has zero unconnected, so an island here is a hole in this model.

With LIMIT_J (A/mm2, the worst conductor at HOVER) and/or LIMIT_LOOP (mohm,
the worst bridge's supply loop) set, it is a gate: exit 2 if either is exceeded.

env: T_OUT / T_IN copper thickness um (35/35), T_PLATE barrel plating um (20),
     I_HOVER amps total (0.62 = 5.6 W / 9 V), I_PEAK amps total (3.0),
     FEEDS="x,y;x,y" extra feed points (same potential as the header pin),
     CELL zone raster mm (0.1)
"""
import json, math, os, re, sys
from collections import defaultdict
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl

RHO = 1.72e-5                                   # ohm mm, annealed copper at 20 C
T_OUT = float(os.environ.get('T_OUT', 35)) / 1000
T_IN = float(os.environ.get('T_IN', 35)) / 1000
T_PLATE = float(os.environ.get('T_PLATE', 20)) / 1000
I_HOVER = float(os.environ.get('I_HOVER', 0.62))
I_PEAK = float(os.environ.get('I_PEAK', 3.0))
CELL = float(os.environ.get('CELL', 0.1))
NETS = ('VBUS', 'GND')
LAYERS = ['F.Cu'] + [f'In{k}.Cu' for k in range(1, 13)] + ['B.Cu']
LZ = {l: k for k, l in enumerate(LAYERS)}
thick = lambda l: T_OUT if l in ('F.Cu', 'B.Cu') else T_IN


def load(path):
    t = open(path).read()
    nets = {int(m.group(1)): m.group(2) for m in re.finditer(r'^  \(net (\d+) "([^"]*)"\)$', t, re.M)}
    inv = {v: k for k, v in nets.items()}
    bt = re.search(r'\(general \(thickness ([\d.]+)\)', t)
    board_t = float(bt.group(1)) if bt else 1.84
    segs = defaultdict(list); vias = defaultdict(list); pads = defaultdict(list); zones = defaultdict(list)
    for m in re.finditer(r'^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "([^"]+)"\) \(net (\d+)\)', t, re.M):
        n = nets[int(m.group(7))]
        if n in NETS: segs[n].append((*map(float, m.group(1, 2, 3, 4, 5)), m.group(6)))
    for m in re.finditer(r'^  \(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill ([\d.]+)\) \(layers "[^"]+" "[^"]+"\)(?: \(locked\))? \(net (\d+)\)', t, re.M):
        n = nets[int(m.group(5))]
        if n in NETS: vias[n].append(tuple(map(float, m.group(1, 2, 3, 4))))
    for m in re.finditer(r'  \(footprint "maglev:[^"]+" \(layer "[^"]+"\) \(at ([-\d.]+) ([-\d.]+)[^)]*\)([\s\S]*?)\n  \)\n', t):
        fx, fy = float(m.group(1)), float(m.group(2))
        ref = re.search(r'fp_text reference "([^"]+)"', m.group(3)).group(1)
        for p in re.finditer(r'\(pad "([^"]+)" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\) \(layers "([^"]+)"[^\n]*?\(net \d+ "([^"]*)"\)', m.group(3)):
            if p.group(8) in NETS:
                pads[p.group(8)].append(dict(ref=ref, pad=p.group(1), x=fx + float(p.group(2)), y=fy + float(p.group(3)),
                                             deg=float(p.group(4) or 0), w=float(p.group(5)), h=float(p.group(6)), layer=p.group(7)))
    # filled zones: (zone (net N) ... (filled_polygon (layer "L") (pts (xy ..) ...)))
    for zm in re.finditer(r'^  \(zone \(net (\d+)\)[\s\S]*?\n  \)\n', t, re.M):
        n = nets[int(zm.group(1))]
        if n not in NETS: continue
        for fm in re.finditer(r'\(filled_polygon \(layer "([^"]+)"\) \(pts((?:\s*\(xy [-\d.]+ [-\d.]+\))+)\)\)', zm.group(0)):
            pts = [(float(a), float(b)) for a, b in re.findall(r'\(xy ([-\d.]+) ([-\d.]+)\)', fm.group(2))]
            if len(pts) >= 3: zones[n].append((fm.group(1), pts))
    return dict(segs=segs, vias=vias, pads=pads, zones=zones, board_t=board_t)


class Net:
    """nodes are created on demand; res() adds a conductor between two of them"""
    def __init__(self):
        self.n = 0; self.I = []; self.J = []; self.G = []; self.meta = []; self.pos = []
    def node(self, x, y, layer):
        self.pos.append((x, y, layer)); self.n += 1; return self.n - 1
    def res(self, a, b, r, area=None, what=None):
        if a == b: return
        self.I.append(a); self.J.append(b); self.G.append(1.0 / max(r, 1e-9)); self.meta.append((area, what))


def in_pad(p, x, y, grow=0.0):
    a = math.radians(p['deg']); ca, sa = math.cos(a), math.sin(a)
    dx, dy = x - p['x'], y - p['y']
    return abs(dx * ca - dy * sa) <= p['w'] / 2 + grow and abs(dx * sa + dy * ca) <= p['h'] / 2 + grow


def corners(p):
    a = math.radians(p['deg']); ca, sa = math.cos(a), math.sin(a)
    return [(p['x'] + (u * p['w'] / 2) * ca + (v * p['h'] / 2) * sa, p['y'] - (u * p['w'] / 2) * sa + (v * p['h'] / 2) * ca) for u, v in ((1, 1), (1, -1), (-1, -1), (-1, 1))] + [(p['x'], p['y'])]


def raster_poly(pts, cell, x0, y0, nx, ny):
    """even-odd scanline fill of one polygon onto the cell-centre lattice"""
    out = np.zeros((ny, nx), bool)
    P = np.array(pts); xs, ys = P[:, 0], P[:, 1]
    j0 = max(0, int(math.floor((ys.min() - y0) / cell))); j1 = min(ny - 1, int(math.ceil((ys.max() - y0) / cell)))
    x1, y1 = xs, ys; x2, y2 = np.roll(xs, -1), np.roll(ys, -1)
    for j in range(j0, j1 + 1):
        y = y0 + (j + 0.5) * cell
        k = (y1 <= y) != (y2 <= y)
        if not k.any(): continue
        xc = np.sort(x1[k] + (y - y1[k]) * (x2[k] - x1[k]) / (y2[k] - y1[k]))
        for a, b in zip(xc[0::2], xc[1::2]):
            i0 = max(0, int(math.ceil((a - x0) / cell - 0.5))); i1 = min(nx - 1, int(math.floor((b - x0) / cell - 0.5)))
            if i1 >= i0: out[j, i0:i1 + 1] ^= True
    return out


def build(d, name, feeds):
    segs, vias, pads, zones = d['segs'][name], d['vias'][name], d['pads'][name], d['zones'][name]
    N = Net()
    # --- split every track at everything that lands on it -------------------------
    by_layer = defaultdict(list)
    for k, s in enumerate(segs): by_layer[s[5]].append(k)
    cuts = [[0.0, 1.0] for _ in segs]
    attach = []                                   # (seg k, t, kind, index)
    for layer, ks in by_layer.items():
        A = np.array([[segs[k][0], segs[k][1]] for k in ks]); Bp = np.array([[segs[k][2], segs[k][3]] for k in ks])
        D = Bp - A; L2 = (D ** 2).sum(1); L2[L2 == 0] = 1e-12
        W = np.array([segs[k][4] for k in ks])
        def hits(px, py, reach):
            t = np.clip(((px - A[:, 0]) * D[:, 0] + (py - A[:, 1]) * D[:, 1]) / L2, 0, 1)
            dist = np.hypot(A[:, 0] + t * D[:, 0] - px, A[:, 1] + t * D[:, 1] - py)
            idx = np.nonzero(dist <= reach)[0]
            return idx, t
        ends = np.concatenate([A, Bp])
        for q, (px, py) in enumerate(ends):       # track ends on other tracks (T junctions)
            idx, t = hits(px, py, W / 2)           # an end inside another track's copper
            for i in idx:
                if i != q % len(ks):
                    cuts[ks[i]].append(float(t[i])); attach.append((ks[i], float(t[i]), 'end', (ks[q % len(ks)], float(q >= len(ks)))))
        for vi, (vx, vy, vs, vd) in enumerate(vias):
            idx, t = hits(vx, vy, vs / 2)
            for i in idx:
                cuts[ks[i]].append(float(t[i])); attach.append((ks[i], float(t[i]), 'via', vi))
        for pi, p in enumerate(pads):
            if p['layer'] != layer: continue
            idx, t = hits(p['x'], p['y'], math.hypot(p['w'], p['h']) / 2 + 0.06)
            for i in idx:
                s = segs[ks[i]]
                # the point of the track's centreline nearest the pad centre, and both ends
                for tt in (float(t[i]), 0.0, 1.0):
                    x, y = s[0] + tt * (s[2] - s[0]), s[1] + tt * (s[3] - s[1])
                    if in_pad(p, x, y, s[4] / 2 - 0.005):
                        cuts[ks[i]].append(tt); attach.append((ks[i], tt, 'pad', pi)); break
    # --- nodes: snapped points per layer -----------------------------------------
    key = {}
    def pt(x, y, layer):
        k = (round(x / 0.004), round(y / 0.004), layer)
        for dxk in (0, -1, 1):
            for dyk in (0, -1, 1):
                kk = (k[0] + dxk, k[1] + dyk, layer)
                if kk in key: return key[kk]
        key[k] = N.node(x, y, layer); return key[k]
    segnode = {}
    for k, s in enumerate(segs):
        ts = sorted(set(round(t, 6) for t in cuts[k]))
        L = math.hypot(s[2] - s[0], s[3] - s[1]); area = s[4] * thick(s[5])
        prev = None
        for t in ts:
            n = pt(s[0] + t * (s[2] - s[0]), s[1] + t * (s[3] - s[1]), s[5]); segnode[(k, t)] = n
            if prev is not None:
                N.res(prev[1], n, RHO * L * (t - prev[0]) / area, area, ('track', s[5], round(s[4], 3), k))
            prev = (t, n)
    # --- via barrels: a chain down the layers that something is attached on --------
    dz = d['board_t'] / (len(LAYERS) - 1)
    vnode = [dict() for _ in vias]
    def via_node(vi, layer):
        if layer not in vnode[vi]: vnode[vi][layer] = N.node(vias[vi][0], vias[vi][1], layer)
        return vnode[vi][layer]
    padnode = [None] * len(pads)
    def pad_node(pi):
        if padnode[pi] is None: padnode[pi] = N.node(pads[pi]['x'], pads[pi]['y'], pads[pi]['layer'])
        return padnode[pi]
    for k, t, kind, i in attach:
        a = segnode[(k, round(t, 6))]
        b = via_node(i, segs[k][5]) if kind == 'via' else pad_node(i) if kind == 'pad' else segnode[(i[0], i[1])]
        N.res(a, b, 1e-6)
    for pi, p in enumerate(pads):                 # two pads of the net that overlap (a feed tab on its pin)
        for qi in range(pi):
            q = pads[qi]
            if q['layer'] == p['layer'] and abs(q['x'] - p['x']) < 3 and abs(q['y'] - p['y']) < 3 and \
               any(in_pad(p, *c) for c in corners(q)) or any(in_pad(q, *c) for c in corners(p)) and q['layer'] == p['layer']:
                N.res(pad_node(pi), pad_node(qi), 1e-6)
    for pi, p in enumerate(pads):                 # a via land overlapping a pad
        for vi, (vx, vy, vs, vd) in enumerate(vias):
            if abs(vx - p['x']) < 3 and abs(vy - p['y']) < 3 and in_pad(p, vx, vy, vs / 2 - 0.01):
                N.res(pad_node(pi), via_node(vi, p['layer']), 1e-6)
    # --- zones: a sheet of square cells per layer ---------------------------------
    zstat = {}
    if zones:
        xs = [x for _, pts in zones for x, _ in pts]; ys = [y for _, pts in zones for _, y in pts]
        x0, y0 = min(xs) - CELL, min(ys) - CELL
        nx, ny = int((max(xs) - x0) / CELL) + 2, int((max(ys) - y0) / CELL) + 2
        for layer in sorted({l for l, _ in zones}):
            m = np.zeros((ny, nx), bool)
            for l, pts in zones:
                if l == layer: m |= raster_poly(pts, CELL, x0, y0, nx, ny)
            ids = -np.ones((ny, nx), np.int64); jj, ii = np.nonzero(m)
            base = N.n
            for j, i in zip(jj, ii): N.pos.append((x0 + (i + 0.5) * CELL, y0 + (j + 0.5) * CELL, layer))
            N.n += len(jj); ids[jj, ii] = base + np.arange(len(jj))
            rs = RHO / thick(layer)               # ohm per square; a cell-to-cell link is one square
            for a, b in ((ids[:, :-1], ids[:, 1:]), (ids[:-1, :], ids[1:, :])):
                k = (a >= 0) & (b >= 0)
                for u, v in zip(a[k], b[k]): N.res(int(u), int(v), rs, CELL * thick(layer), ('zone', layer))
            zstat[layer] = round(float(m.sum()) * CELL * CELL, 1)
            def cell_at(x, y):
                i, j = int((x - x0) / CELL), int((y - y0) / CELL)
                best = None
                for dj in (0, -1, 1):
                    for di in (0, -1, 1):
                        if 0 <= j + dj < ny and 0 <= i + di < nx and ids[j + dj, i + di] >= 0:
                            dd = (x0 + (i + di + 0.5) * CELL - x) ** 2 + (y0 + (j + dj + 0.5) * CELL - y) ** 2
                            if best is None or dd < best[0]: best = (dd, int(ids[j + dj, i + di]))
                return best[1] if best else None
            for vi, v in enumerate(vias):          # barrels pass through the sheet (solid connection)
                c = cell_at(v[0], v[1])
                if c is not None: N.res(via_node(vi, layer), c, 1e-6)
            for pi, p in enumerate(pads):
                if p['layer'] != layer: continue
                c = cell_at(p['x'], p['y'])
                if c is not None: N.res(pad_node(pi), c, 1e-6)
            for (k, t), n in segnode.items():      # track ends and junctions inside the pour
                if segs[k][5] != layer: continue
                c = cell_at(N.pos[n][0], N.pos[n][1])
                if c is not None: N.res(n, c, 1e-6)
    for vi, v in enumerate(vias):
        ls = sorted(vnode[vi], key=lambda l: LZ[l])
        circ = math.pi * v[3] * T_PLATE
        for a, b in zip(ls, ls[1:]):
            N.res(vnode[vi][a], vnode[vi][b], RHO * dz * (LZ[b] - LZ[a]) / circ, circ, ('barrel', round(v[0], 3), round(v[1], 3)))
    # --- terminals -------------------------------------------------------------------
    src = [pad_node(pi) for pi, p in enumerate(pads) if p['ref'].startswith('JSPINE')]
    for fx, fy in feeds:
        best = min(range(len(vias)), key=lambda vi: math.hypot(vias[vi][0] - fx, vias[vi][1] - fy))
        if math.hypot(vias[best][0] - fx, vias[best][1] - fy) > 1.0: raise SystemExit(f'no {name} barrel near feed {fx},{fy}')
        src.append(next(iter(vnode[best].values())) if vnode[best] else via_node(best, 'B.Cu'))
    loads = [(pads[pi]['ref'], pad_node(pi)) for pi, p in enumerate(pads) if re.match(r'U\d+$', p['ref'])]
    return N, src, loads, zstat


def solve(N, src, loads):
    n = N.n
    I, J, G = np.array(N.I), np.array(N.J), np.array(N.G)
    A = sp.coo_matrix((np.concatenate([G, G, -G, -G]), (np.concatenate([I, J, I, J]), np.concatenate([I, J, J, I]))), shape=(n, n)).tocsr()
    ncomp, lab = sp.csgraph.connected_components(A != 0, directed=False)
    home = lab[src[0]]
    lost = [r for r, nd in loads if lab[nd] != home]
    if lost: return None, lost
    fixed = np.zeros(n, bool); fixed[src] = True; fixed[lab != home] = True
    free = np.nonzero(~fixed)[0]
    lu = spl.splu(A[free][:, free].tocsc())
    def run(cur):                                  # cur: amps drawn at each node; returns node drop below the feed
        b = np.zeros(n); b[list(cur.keys())] = list(cur.values())
        v = np.zeros(n); v[free] = lu.solve(b[free]); return v
    return run, []


def report(name, N, loads, run):
    refs = [r for r, _ in loads]; nodes = [nd for _, nd in loads]
    out = {}
    # effective resistance from the feed to each bridge pin (one unit solve each)
    reff = np.array([run({nd: 1.0})[nd] for nd in nodes])
    out['r_to_pin_mohm'] = dict(min=round(reff.min() * 1e3, 1), median=round(float(np.median(reff)) * 1e3, 1), max=round(reff.max() * 1e3, 1), worst=refs[int(reff.argmax())])
    I, J, G = np.array(N.I), np.array(N.J), np.array(N.G)
    area = np.array([m[0] if m[0] else np.nan for m in N.meta])
    for label, tot in (('hover', I_HOVER), ('peak', I_PEAK)):
        v = run({nd: tot / len(nodes) for nd in nodes})
        cur = np.abs(v[I] - v[J]) * G
        jd = cur / area; k = int(np.nanargmax(jd)); kc = int(np.nanargmax(np.where(np.isnan(area), -1, cur)))
        x, y, l = N.pos[I[k]]
        out[label] = dict(total_a=tot, worst_drop_mv=round(float(v[nodes].max()) * 1e3, 1), mean_drop_mv=round(float(v[nodes].mean()) * 1e3, 1),
                          loss_w=round(float((cur ** 2 / G).sum()), 3),
                          worst_j_a_mm2=round(float(jd[k]), 1), worst_j_amps=round(float(cur[k]), 3), worst_j_what=str(N.meta[k][1]), worst_j_at=[round(x, 2), round(y, 2), l],
                          max_conductor_a=round(float(cur[kc]), 3), max_conductor_what=str(N.meta[kc][1]))
    if os.environ.get('MAP'):                      # where the hover drop is lost, as a picture
        from PIL import Image, ImageDraw
        v = run({nd: I_HOVER / len(nodes) for nd in nodes}); P = np.array([(p[0], p[1]) for p in N.pos])
        ppm = 12; x0, y0 = P[:, 0].min() - 1, P[:, 1].min() - 1
        img = Image.new('RGB', (int((P[:, 0].max() + 1 - x0) * ppm), int((P[:, 1].max() + 1 - y0) * ppm)), 'white'); dr = ImageDraw.Draw(img)
        top = float(os.environ.get('MAP_MV', 0)) / 1e3 or float(v[nodes].max())
        ramp = lambda f: (int(255 * min(1, 2 * f)), int(255 * (1 - abs(2 * f - 1) * 0.6) * (1 - 0.5 * f)), int(255 * max(0, 1 - 2 * f)))
        for k in np.argsort(v):
            X, Y = (P[k, 0] - x0) * ppm, (P[k, 1] - y0) * ppm
            dr.rectangle([X - 1, Y - 1, X + 1, Y + 1], fill=ramp(min(1.0, v[k] / top)))
        img.save(f"{os.environ['MAP']}.{name}.png"); out['map_full_scale_mv'] = round(top * 1e3, 1)
    out['_reff'] = dict(zip(refs, (reff * 1e3).round(2).tolist()))
    return out


def main():
    board = sys.argv[1]
    d = load(board)
    feeds = [tuple(map(float, f.split(','))) for f in os.environ.get('FEEDS', '').split(';') if f]
    res = {'board': board, 'assume': dict(t_outer_um=T_OUT * 1e3, t_inner_um=T_IN * 1e3, t_plate_um=T_PLATE * 1e3, board_mm=d['board_t'])}
    ok = True
    for name in NETS:
        N, src, loads, zstat = build(d, name, feeds)
        if not src: raise SystemExit(f'{name}: no header pad (JSPINE) on this board')
        run, lost = solve(N, src, loads)
        widths = defaultdict(float)
        for s in d['segs'][name]: widths[round(s[4], 3)] += math.hypot(s[2] - s[0], s[3] - s[1])
        print(f"{name}: {len(d['segs'][name])} tracks ({', '.join(f'{w} mm x {l:.0f} mm' for w, l in sorted(widths.items()))}), {len(d['vias'][name])} barrels, "
              f"{len(loads)} bridge pins, zone mm2 {zstat or 'none'}, {N.n} nodes")
        if lost:
            print(f'  MODEL HOLE: {len(lost)} bridge pins not reachable from the header: {lost[:8]}'); ok = False; continue
        r = report(name, N, loads, run); res[name] = r
        q = r['r_to_pin_mohm']
        print(f"  feed -> bridge pin: {q['min']} / {q['median']} / {q['max']} mohm (min / median / max, worst {q['worst']})")
        for label in ('hover', 'peak'):
            h = r[label]
            print(f"  {label} {h['total_a']} A: drop worst {h['worst_drop_mv']} mV, mean {h['mean_drop_mv']} mV, loss {h['loss_w']} W; "
                  f"worst J {h['worst_j_a_mm2']} A/mm2 ({h['worst_j_amps']} A in {h['worst_j_what']} at {h['worst_j_at']}); "
                  f"most current in one conductor {h['max_conductor_a']} A {h['max_conductor_what']}")
    if ok:
        refs = res['VBUS']['_reff'].keys() & res['GND']['_reff'].keys()
        loop = {r: res['VBUS']['_reff'][r] + res['GND']['_reff'][r] for r in refs}
        w = max(loop, key=loop.get); vals = sorted(loop.values())
        res['loop_mohm'] = dict(min=round(vals[0], 1), median=round(vals[len(vals) // 2], 1), max=round(vals[-1], 1), worst=w)
        print(f"supply loop per bridge (VBUS + GND): {vals[0]:.0f} / {vals[len(vals) // 2]:.0f} / {vals[-1]:.0f} mohm (min / median / max, worst {w}) against a 10 ohm coil")
        print(f"rail lost at the worst bridge: hover {res['VBUS']['hover']['worst_drop_mv'] + res['GND']['hover']['worst_drop_mv']:.0f} mV, peak {res['VBUS']['peak']['worst_drop_mv'] + res['GND']['peak']['worst_drop_mv']:.0f} mV of 9000")
    bad = []
    if ok:
        lj, ll = float(os.environ.get('LIMIT_J', 0)), float(os.environ.get('LIMIT_LOOP', 0))
        wj = max(res[n]['hover']['worst_j_a_mm2'] for n in NETS)
        if lj and wj > lj: bad.append(f'worst conductor at hover {wj} A/mm2 > {lj}')
        if ll and res['loop_mohm']['max'] > ll: bad.append(f"worst supply loop {res['loop_mohm']['max']} mohm > {ll}")
        if lj or ll: print('powercheck: ' + ('FAIL -- ' + '; '.join(bad) if bad else f'OK (hover J <= {lj or "-"} A/mm2, loop <= {ll or "-"} mohm)'))
        res['limits'] = dict(j_hover=lj, loop_mohm=ll, failed=bad)
    if len(sys.argv) > 2:
        for n in NETS: res.get(n, {}).pop('_reff', None)
        json.dump(res, open(sys.argv[2], 'w'), indent=1)
    sys.exit(1 if not ok else 2 if bad else 0)


if __name__ == '__main__':
    main()
