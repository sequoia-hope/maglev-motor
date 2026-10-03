#!/usr/bin/env python3
"""Power rails: pour VBUS and GND into the copper the routed board left empty.

  pour.py <in.kicad_pcb> <out.kicad_pcb>

Every bus lane on this board is a 0.1 mm track, power included, and no wider
lane fits. What the board does have is the GUTTER: 1.7 mm between neighbouring
windings on all twelve winding layers, holding nothing but barrels. This pours
the two power nets into it -- GND on seven layers, VBUS on the other seven,
alternating, so the two rails lie on top of each other -- with KiCad's own zone
filler against the board's own rule files, so the pour clears foreign copper,
foreign holes and the board edge by what DRC will check. The tracks stay: the
pour is copper in parallel with them. Every power barrel standing in a gutter
joins the rail on each of its net's layers.

A poured honeycomb is a closed copper ring round every coil on every layer: a
shorted turn, coupled to a 144-turn winding that is switched at PWM frequency.
So the pour is cut into a TREE:

  * the gutter lattice is a honeycomb graph (junctions and flats). It is poured
    whole and SOLVED (powercheck.py's network: every pour cell, barrel and
    track, the header feeding, every bridge loading), and the current the pour
    carries through each flat is read off -- because what blocks a gutter is
    the routed board (a bus ladder, a coil's crossover farm, a link riding a
    winding layer, two layers with no barrel between them), and that repeats
    with the stamp, not with any rule that could be written down in advance;
  * the rails are the MAXIMUM SPANNING TREE of that graph, a flat's weight
    its VBUS current plus its GND current: the arteries the honeycomb was
    already using. Both nets take the same tree, so the two rails lie on top
    of each other and enclose nothing between them;
  * every flat that is not in the tree gets one SLIT across its middle: one
    slit per coil, the fewest that leaves no ring;
  * no pour over a coil FACE on the two electronics layers (a sheet under the
    winding is the same shorted turn), except a patch round the header's own
    power pads, which is the feed.

The slits and face keepouts are written into the board as rule areas, so a
refill in KiCad reproduces this fill and not the honeycomb. ringcheck.py is
the gate: it proves from the filled copper that no coil is encircled.

env: BASE (terminals.json key for the coil centres, default fabtile2),
     CLR (pour clearance mm, 0.12: a third over the fab minimum, because a
     pour-to-winding short kills a coil AND a rail), MINW (narrowest neck kept,
     0.1), SLIT (mm, 0.2), FEED (half-size mm of the header patch, 2.2), FEEDV (half-size mm of the VBUS pin's own B.Cu pour, 1.3),
     PLAN ("LAYER:NET,..." to override the layer plan)
"""
import json, math, os, re, sys, time
import pcbnew

src, dst = sys.argv[1:3]
BASE = os.environ.get('BASE', 'fabtile2')
CLR = float(os.environ.get('CLR', 0.12)); MINW = float(os.environ.get('MINW', 0.1))
SLIT = float(os.environ.get('SLIT', 0.2)); FEED = float(os.environ.get('FEED', 2.2)); FEEDV = float(os.environ.get('FEEDV', 1.3))
WIND = ['F.Cu'] + [f'In{k}.Cu' for k in range(1, 12)]
ELEC = ['In12.Cu', 'B.Cu']
plan = [a.split(':') for a in os.environ['PLAN'].split(',')] if os.environ.get('PLAN') else \
       [[l, 'GND' if k % 2 == 0 else 'VBUS'] for k, l in enumerate(WIND)] + [['In12.Cu', 'VBUS'], ['B.Cu', 'GND']]
mm = pcbnew.FromMM
t = open(src).read()
t = re.sub(r'^  \(zone \(net \d+\)[\s\S]*?\n  \)\n', '', t, flags=re.M)     # re-pouring starts clean

# ---- the lattice ---------------------------------------------------------------
coils = json.load(open(f'{BASE}.terminals.json'))['coils']
rows = {}
for x, y in coils: rows.setdefault(round(y, 3), []).append(x)
pitch = min(b - a for xs in rows.values() for a, b in zip(sorted(xs), sorted(xs)[1:]))
m = re.search(r'coilFill: ([\d.]+)', open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../src/app.js')).read().split('amzhex: {')[1])
face = float(m.group(1)) * pitch / 2 + 0.06                 # apothem of the winding's outer edge
hdr = [(float(a), float(b)) for a, b in re.findall(r'\(footprint "maglev:HDR10" \(layer "[^"]+"\) \(at ([-\d.]+) ([-\d.]+)', t)]
if not hdr: raise SystemExit('no header on this board: nothing to feed the rails from')
hx, hy = hdr[0]
pw_net = [(hx + float(a), hy + float(b), n) for a, b, n in re.findall(r'\(pad "[^"]+" smd rect \(at ([-\d.]+) ([-\d.]+)[^\n]*?"B\.Mask"\) \(net \d+ "(VBUS|GND)"\)', t[t.index('"maglev:HDR10"'):].split('\n  )\n')[0])]
pw = [(x, y) for x, y, _ in pw_net]
src_xy = (sum(x for x, _ in pw) / len(pw), sum(y for _, y in pw) / len(pw))     # where the rails are fed

rect = lambda x, y, w, h: [(x - w / 2, y - h / 2), (x + w / 2, y - h / 2), (x + w / 2, y + h / 2), (x - w / 2, y + h / 2)]
# the honeycomb: junctions (hexagon corners) and flats (hexagon sides), deduplicated
Rc = pitch / math.sqrt(3)
vid, verts, edges = {}, [], {}
def vert(x, y):
    k = (round(x, 2), round(y, 2))
    if k not in vid: vid[k] = len(verts); verts.append((x, y))
    return vid[k]
faces = []
for ci, (x, y) in enumerate(coils):
    ring = [vert(x + Rc * math.cos(math.radians(30 + 60 * i)), y + Rc * math.sin(math.radians(30 + 60 * i))) for i in range(6)]
    for i in range(6):
        e = tuple(sorted((ring[i], ring[(i + 1) % 6]))); edges.setdefault(e, []).append(ci)
    faces.append((x, y, [(x + face / math.cos(math.pi / 6) * math.cos(math.radians(30 + 60 * i)), y + face / math.cos(math.pi / 6) * math.sin(math.radians(30 + 60 * i))) for i in range(6)]))
edges = [(u, v, cs) for (u, v), cs in edges.items()]
reach = pitch - 2 * face + 2.0                               # a slit spans the gutter and then some
def slit_of(u, v):
    (ax, ay), (bx, by) = verts[u], verts[v]
    mx, my = (ax + bx) / 2, (ay + by) / 2; L = math.hypot(bx - ax, by - ay); tx, ty = (bx - ax) / L, (by - ay) / L
    return [(mx + a * -ty * reach / 2 + c * tx * SLIT / 2, my + a * tx * reach / 2 + c * ty * SLIT / 2) for a, c in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
# the feed patch: the header's coil faces stay open to the pour inside this box
feed = (hx - FEED, hy - FEED - 1.0, hx + FEED, hy + FEED + 1.0)
def clip_face(hexagon):
    """the face keepout minus the feed box: keep the hexagon whole unless the box touches it"""
    xs = [p[0] for p in hexagon]; ys = [p[1] for p in hexagon]
    if max(xs) < feed[0] or min(xs) > feed[2] or max(ys) < feed[1] or min(ys) > feed[3]: return [hexagon]
    a = pcbnew.SHAPE_POLY_SET(); a.NewOutline()
    for x, y in hexagon: a.Append(mm(x), mm(y))
    c = pcbnew.SHAPE_POLY_SET(); c.NewOutline()
    for x, y in rect((feed[0] + feed[2]) / 2, (feed[1] + feed[3]) / 2, feed[2] - feed[0], feed[3] - feed[1]): c.Append(mm(x), mm(y))
    a.BooleanSubtract(c)
    return [[(pcbnew.ToMM(a.Outline(i).CPoint(k).x), pcbnew.ToMM(a.Outline(i).CPoint(k).y)) for k in range(a.Outline(i).PointCount())] for i in range(a.OutlineCount())]
keepouts = [('face', ELEC, q) for _, _, h in faces for q in clip_face(h)]

# ---- fill ------------------------------------------------------------------------
tmp = dst + '.pour-in.kicad_pcb'
open(tmp, 'w').write(t)
for ext in ('kicad_pro', 'kicad_dru'):                          # the filler reads the rules beside the board
    for s in (re.sub(r'\.kicad_pcb$', '.' + ext, src), re.sub(r'\.kicad_pcb$', '.' + ext, dst)):
        if os.path.exists(s): open(re.sub(r'\.kicad_pcb$', '.' + ext, tmp), 'w').write(open(s).read()); break
    else: raise SystemExit(f'pour.py: no .{ext} beside {src} or {dst} -- the filler would pour against KiCad defaults, not the fab rules')
b = pcbnew.LoadBoard(tmp)
bb = b.GetBoardEdgesBoundingBox()
def lset(names):
    ls = pcbnew.LSET()
    for n in names: ls.AddLayer(b.GetLayerID(n))
    return ls
# ---- write back as TEXT, in the generator's own format: every tool in this
# directory reads the file with regular expressions, and SaveBoard reformats it
# eight points to a line: KiCad's reader gives up on a line over a megabyte, and
# one pour polygon can be 90 000 points
xy = lambda pts: ' '.join(('\n      ' if k and k % 8 == 0 else '') + f'(xy {x:.4f} {y:.4f})' for k, (x, y) in enumerate(pts))
tot = {}
def emit(path, keepouts):
    blocks = []; tot.clear()
    for kind, layers, pts in keepouts:
        blocks.append(f'  (zone (net 0) (net_name "") (layers {" ".join(chr(34) + l + chr(34) for l in layers)}) (name "{kind}") (hatch edge 0.3)\n'
                      '    (connect_pads (clearance 0)) (min_thickness 0.1) (filled_areas_thickness no)\n'
                      '    (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))\n'
                      '    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n'
                      f'    (polygon (pts {xy(pts)}))\n  )')
    for z in zones:
        layer = b.GetLayerName(z.GetLayer()); ps = pcbnew.SHAPE_POLY_SET(z.GetFilledPolysList(z.GetLayer()))
        if any(ps.HoleCount(i) for i in range(ps.OutlineCount())): ps.Fracture()
        tot.setdefault(z.GetNetname(), []).append((layer, ps.Area() / 1e12, ps.OutlineCount()))
        o = z.Outline().Outline(0)
        L = [f'  (zone (net {z.GetNetCode()}) (net_name "{z.GetNetname()}") (layer "{layer}") (name "{z.GetZoneName()}") (hatch edge 0.5)',
             f'    (connect_pads yes (clearance {CLR})) (min_thickness {MINW}) (filled_areas_thickness no)',
             '    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 0))',
             '    (polygon (pts ' + xy([(pcbnew.ToMM(o.CPoint(k).x), pcbnew.ToMM(o.CPoint(k).y)) for k in range(o.PointCount())]) + '))']
        for i in range(ps.OutlineCount()):
            c = ps.Outline(i)
            L.append(f'    (filled_polygon (layer "{layer}") (pts ' + xy([(pcbnew.ToMM(c.CPoint(k).x), pcbnew.ToMM(c.CPoint(k).y)) for k in range(c.PointCount())]) + '))')
        L.append('  )'); blocks.append('\n'.join(L))
    end = t.rstrip().rfind(')')
    open(path, 'w').write(t[:end] + '\n'.join(blocks) + '\n)\n')
def rule_area(kind, layers, pts):
    z = pcbnew.ZONE(b); z.SetIsRuleArea(True); z.SetLayerSet(lset(layers)); z.SetZoneName(kind)
    z.SetDoNotAllowCopperPour(True)
    for f in (z.SetDoNotAllowTracks, z.SetDoNotAllowVias, z.SetDoNotAllowPads, z.SetDoNotAllowFootprints): f(False)
    o = z.Outline(); o.NewOutline()
    for x, y in pts: o.Append(mm(x), mm(y))
    b.Add(z)
for k in keepouts: rule_area(*k)
zones = []
for layer, net in plan:
    ni = b.FindNet(net)
    if ni is None: raise SystemExit(f'no net {net}')
    z = pcbnew.ZONE(b); z.SetLayer(b.GetLayerID(layer)); z.SetNet(ni); z.SetZoneName(f'{net}@{layer}')
    o = z.Outline(); o.NewOutline()
    for x, y in ((bb.GetLeft(), bb.GetTop()), (bb.GetRight(), bb.GetTop()), (bb.GetRight(), bb.GetBottom()), (bb.GetLeft(), bb.GetBottom())): o.Append(x, y)
    z.SetLocalClearance(mm(CLR)); z.SetMinThickness(mm(MINW))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    b.Add(z); zones.append(z)
# the header's pins are SMD lands on B.Cu, and B.Cu is GND's layer: give the VBUS
# pin its own small B.Cu pour (it wins over GND's inside its box), so the pin is
# joined to the VBUS barrels beside it by all the copper that fits, not one track
if FEED > 0:
    vp = [p for p in pw_net if p[2] == 'VBUS']
    z = pcbnew.ZONE(b); z.SetLayer(b.GetLayerID('B.Cu')); z.SetNet(b.FindNet('VBUS')); z.SetZoneName('VBUS@B.Cu feed')
    o = z.Outline(); o.NewOutline()
    # west and south of the pin only (where the gutter is), never east into the gap
    # between the header's two rows -- that gap is the GND pin's way down to its barrel
    vx, vy = sum(p[0] for p in vp) / len(vp), sum(p[1] for p in vp) / len(vp)
    for x, y in ((vx - FEEDV, vy - 0.6), (vx + 0.37, vy - 0.6), (vx + 0.37, vy + FEEDV), (vx - FEEDV, vy + FEEDV)): o.Append(mm(x), mm(y))
    z.SetLocalClearance(mm(CLR)); z.SetMinThickness(mm(MINW)); z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS); z.SetAssignedPriority(1)
    b.Add(z); zones.append(z)
t0 = time.time()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())                        # 1: the whole honeycomb, to be measured
print(f'{len(zones)} pours over {len(faces)} coils, {len(verts)} junctions, {len(edges)} flats; honeycomb filled in {time.time() - t0:.0f}s')

# ---- measure every flat: the current the honeycomb really sends through it ----------
import numpy as np, scipy.sparse as sp
from scipy.spatial import cKDTree
import powercheck as pc
t0 = time.time()
emit(tmp, keepouts)
d = pc.load(tmp)
mid = np.array([((verts[u][0] + verts[v][0]) / 2, (verts[u][1] + verts[v][1]) / 2) for u, v, _ in edges])
tan = np.array([(verts[v][0] - verts[u][0], verts[v][1] - verts[u][1]) for u, v, _ in edges]); tan /= np.hypot(tan[:, 0], tan[:, 1])[:, None]
kd = cKDTree(mid); HW = (pitch - 2 * face) / 2 + 0.4
flow = {}
for net in pc.NETS:
    N, src_n, loads, _ = pc.build(d, net, [])
    run, lost = pc.solve(N, src_n, loads)
    if lost: raise SystemExit(f'{net}: {len(lost)} bridge pins unreachable in the power model: {lost[:6]}')
    volt = run({nd: 1.0 / len(loads) for _, nd in loads})    # one amp in total
    zk = np.array([k for k, m in enumerate(N.meta) if m[1] and m[1][0] == 'zone'], dtype=np.int64)
    I, J, Gc = np.array(N.I)[zk], np.array(N.J)[zk], np.array(N.G)[zk]
    P = np.array([(p[0], p[1]) for p in N.pos]); pa, pb = P[I], P[J]
    dist, f = kd.query((pa + pb) / 2, distance_upper_bound=HW)
    ok = np.isfinite(dist); f = f[ok]; pa, pb = pa[ok], pb[ok]; cur = ((volt[I] - volt[J]) * Gc)[ok]
    sa = ((pa - mid[f]) * tan[f]).sum(1); sb = ((pb - mid[f]) * tan[f]).sum(1)
    x = (sa < 0) != (sb < 0)                                  # the link steps over the flat's midline
    flow[net] = np.abs(np.bincount(f[x], weights=(cur * np.sign(sb - sa))[x], minlength=len(edges)))
w = sum(flow.values())
src_v = min(range(len(verts)), key=lambda k: math.hypot(verts[k][0] - src_xy[0], verts[k][1] - src_xy[1]))
mst = sp.csgraph.minimum_spanning_tree(sp.coo_matrix((w.max() * 1.001 - w + 1e-9, ([e[0] for e in edges], [e[1] for e in edges])), shape=(len(verts), len(verts)))).tocoo()
tree = {tuple(sorted((int(a_), int(b_)))) for a_, b_ in zip(mst.row, mst.col)}
cut = [(u, v) for u, v, _ in edges if (u, v) not in tree]
dead = {net: int((g < 1e-4).sum()) for net, g in flow.items()}
print(f'flats measured in {time.time() - t0:.0f}s: carrying nothing {dead}; tree: {len(tree)} flats kept, {len(cut)} slit '
      f'(the slit flats carried {100 * sum(w[k] for k, (u, v, _) in enumerate(edges) if (u, v) not in tree) / w.sum():.0f}% of the flat-current)')
slits = [slit_of(u, v) for u, v in cut]
for p in slits: rule_area('slit', WIND + ELEC, p)
keepouts += [('slit', WIND + ELEC, p) for p in slits]
t0 = time.time()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())                        # 2: the tree
print(f'tree filled in {time.time() - t0:.0f}s')

emit(dst, keepouts)
for net, ls in tot.items():
    print(f'  {net}: {sum(a for _, a, _ in ls):.0f} mm2 on {len(ls)} layers ({", ".join(f"{l.replace(chr(46) + chr(67) + chr(117), str())} {a:.0f}" for l, a, _ in ls)})')
for ext in ('kicad_pcb', 'kicad_pro', 'kicad_dru', 'kicad_prl'):
    p = re.sub(r'\.kicad_pcb$', '.' + ext, tmp)
    if os.path.exists(p): os.remove(p)
json.dump({'pitch': pitch, 'face': face, 'source': verts[src_v], 'slits': len(slits), 'flats': len(edges), 'junctions': len(verts), 'idle_flats': dead,
           'tree': [[verts[u], verts[v]] for u, v in tree], 'feed': feed, 'clr': CLR, 'minw': MINW,
           'plan': plan, 'area_mm2': {n: round(sum(a for _, a, _ in ls)) for n, ls in tot.items()}}, open(re.sub(r'\.kicad_pcb$', '.pour.json', dst), 'w'))
print('wrote', dst)
