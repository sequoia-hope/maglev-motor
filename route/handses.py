#!/usr/bin/env python3
"""Extract the hand-routed stamp copper -- every UNLOCKED track and via -- into
a freerouting-format .ses the rest of the pipeline already speaks: tilecheck
gates it against the 8 periodic images, mkses merges it onto the bare board,
quadclone stamps it 42x.

  handses.py <hand.kicad_pcb> <out.ses> [quads.json]

The lock flag is ownership (see handlock.py): the generated board and the
neighbour images are locked, so what remains unlocked is by construction the
stamp's routed copper, whether it came from the pipeline's union.ses or from
your mouse.  Board nets are translated back into the stamp's vocabulary
(DATA_21 -> DATA_W, coil_78 -> coil_78_A, globals stay themselves); copper on
any net the stamp does not own -- a neighbour's PWM, a rim cell's coil -- is
REFUSED loudly, because it cannot be stamp copper.

Hand-drawn arcs are tessellated to < 5 um chord error (the ses grammar has no
arcs); DRC and tilecheck then see the polyline, which is what gets fabbed.
"""
import json
import math
import re
import sys
from collections import defaultdict

import pcbnew

inp = sys.argv[1] if len(sys.argv) > 1 else 'hand.kicad_pcb'
outp = sys.argv[2] if len(sys.argv) > 2 else 'hand.union.ses'
quadsp = sys.argv[3] if len(sys.argv) > 3 else 'fabtile2.quads.json'

spec = json.load(open(quadsp))
CQ = spec['centreQuad']
CELLS = set(spec['quads'][CQ]['cells'])
GLOBALS = {'GND', 'VBUS', 'VLOGIC', 'SCLK', 'RCLK', 'OE_N', 'SDA', 'SCL'}


def stamp_net(name):
    """board net -> stamp net vocabulary, or None if the stamp does not own it"""
    m = re.fullmatch(r'coil_(\d+)', name)
    if m:
        return f'coil_{m.group(1)}_A' if int(m.group(1)) in CELLS else None
    m = re.fullmatch(r'PWM[AB]_(\d+)', name)
    if m:
        return name if int(m.group(1)) in CELLS else None
    m = re.fullmatch(r'DATA_(\d+)', name)
    if m:
        return {CQ: 'DATA_W', CQ + 1: 'DATA_E'}.get(int(m.group(1)))
    return name if name in GLOBALS else None


def arc_points(arc):
    """tessellate a PCB_ARC to <= TOL sagitta, returned as nm points"""
    TOL = 5000  # nm
    s, e, mid = arc.GetStart(), arc.GetEnd(), arc.GetMid()
    ax, ay, bx, by, cx, cy = s.x, s.y, mid.x, mid.y, e.x, e.y
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if d == 0:
        return [(ax, ay), (cx, cy)]
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay)
          + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx)
          + (cx * cx + cy * cy) * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    a0 = math.atan2(ay - uy, ax - ux)
    am = math.atan2(by - uy, bx - ux)
    a1 = math.atan2(cy - uy, cx - ux)
    # sweep from a0 through am to a1
    def fwd(f, t):
        return (t - f) % (2 * math.pi)
    sweep = fwd(a0, a1) if fwd(a0, am) <= fwd(a0, a1) else fwd(a0, a1) - 2 * math.pi
    step = 2 * math.acos(max(0.0, 1 - TOL / r)) if r > TOL else abs(sweep)
    n = max(2, math.ceil(abs(sweep) / max(step, 1e-6)))
    return [(round(ux + r * math.cos(a0 + sweep * k / n)),
             round(uy + r * math.sin(a0 + sweep * k / n))) for k in range(n + 1)]


board = pcbnew.LoadBoard(inp)
wires = defaultdict(list)   # net -> [(layer, width_units, [(x,y) units...])]
vias = defaultdict(list)    # net -> [(x, y) units]
refused = defaultdict(int)
arcs = 0
U = lambda nm: round(nm / 100)   # nm -> session units (0.1 um)

for t in board.GetTracks():
    if t.IsLocked():
        continue
    net = stamp_net(t.GetNetname())
    if net is None:
        refused[t.GetNetname() or '<none>'] += 1
        continue
    if isinstance(t, pcbnew.PCB_VIA):
        p = t.GetPosition()
        vias[net].append((U(p.x), U(p.y)))
    elif isinstance(t, pcbnew.PCB_ARC):
        arcs += 1
        pts = [(U(x), U(y)) for x, y in arc_points(t)]
        wires[net].append((board.GetLayerName(t.GetLayer()), U(t.GetWidth()), pts))
    else:
        s, e = t.GetStart(), t.GetEnd()
        if (s.x, s.y) == (e.x, e.y):
            continue
        wires[net].append((board.GetLayerName(t.GetLayer()), U(t.GetWidth()),
                           [(U(s.x), U(s.y)), (U(e.x), U(e.y))]))

blocks = []
for net in sorted(set(wires) | set(vias)):
    b = [f'      (net {net}']
    for layer, w, pts in wires[net]:
        coords = '  '.join(f'{x} {-y}' for x, y in pts)
        b.append(f'        (wire\n          (path {layer} {w} {coords}\n          )\n        )')
    for x, y in vias[net]:
        b.append(f'        (via "Via_route" {x} {-y}\n        )')
    b.append('      )')
    blocks.append('\n'.join(b))

ses = ('(session hand\n  (base_design hand)\n  (placement\n'
       '    (resolution um 10)\n  )\n  (was_is\n  )\n  (routes \n'
       '    (resolution um 10)\n    (parser\n      (host_cad "handses.py")\n'
       '    )\n    (library_out \n    )\n    (network_out \n'
       + '\n'.join(blocks) + '\n    )\n  )\n)\n')
open(outp, 'w').write(ses)

nseg = sum(len(pts) - 1 for ws in wires.values() for _, _, pts in ws)
nvia = sum(len(v) for v in vias.values())
print(f'{nseg} segments, {nvia} vias on {len(blocks)} nets -> {outp}'
      + (f'  ({arcs} arcs tessellated)' if arcs else ''))
for net in sorted(set(wires) | set(vias)):
    ns = sum(len(p) - 1 for _, _, p in wires[net])
    print(f'   {net:12s} {ns:4d} seg {len(vias[net]):3d} via')
if refused:
    print('REFUSED copper on nets the stamp does not own (fix or delete it):')
    for k, v in sorted(refused.items()):
        print(f'   {k}: {v} items')
    sys.exit(1)
