#!/usr/bin/env python3
"""Draw the tile's airwires -- the TRUE ratsnest, one colour per net.

kicad-cli's DRC report caps every list at ~500 items, so the airwires come
from the board's own connectivity graph instead: pcbnew clusters each net's
copper (pads, vias, tracks, arcs, layer-aware), and every pair of clusters
that should be one is an airwire.  Edges are a minimum spanning tree over the
clusters' nearest anchor points, which is what pcbnew itself draws.

"The tile's" airwires, not the board's: on the merged board only the centre
quad is routed, so every neighbouring quad in the window is a sea of benign
danglers.  Ownership follows the pipeline's own bookkeeping:
  * nets NAMED for the quad (suffix in its cell numbers or its quad number:
    PWMA_78, coil_91_B, DATA_21 ...) belong to the tile outright;
  * shared lane nets (GND, VBUS, VLOGIC, SCLK ...) belong to the tile only
    where a cluster holds a pad of a tile footprint (SR21, U78, C90 ...);
  * a lane cluster whose copper spans the full stamp width is an E-W row
    ladder that already reaches its seam vias -- interface-complete.  Tying
    the two rows' ladders together is the margin spine's job (board-level
    remainder), so ladders count as one; a bare register pin does not.

The result should equal <key>.lanes.todo.json plus nothing -- when it does
not, the picture is the diff worth staring at.

  airwires.py [board] [x1 y1 x2 y2] [base.png] [out.png]

Defaults: fabtile2.merged.kicad_pcb, the QUAD window from report.sh, base
report/quad-allcu.png (same window, unmirrored -- run report.sh first), out
report/airwires.png + airwires.json beside it.
"""
import json
import re
import sys
import time

import numpy as np
import pcbnew
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial import cKDTree

BOARD = sys.argv[1] if len(sys.argv) > 1 else 'fabtile2.merged.kicad_pcb'
WIN = list(map(float, sys.argv[2:6])) if len(sys.argv) > 5 else [59.0, 53.0, 84.0, 73.0]
BASE = sys.argv[6] if len(sys.argv) > 6 else 'report/quad-allcu.png'
OUT = sys.argv[7] if len(sys.argv) > 7 else 'report/airwires.png'
X1, Y1, X2, Y2 = WIN

t0 = time.time()
board = pcbnew.LoadBoard(BOARD)
conn = board.GetConnectivity()
conn.RecalculateRatsnest()
board_unconnected = conn.GetUnconnectedCount(True)

netname = {}
ni = board.GetNetInfo()
for code in range(ni.GetNetCount()):
    n = ni.GetNetItem(code)
    if n:
        netname[code] = n.GetNetname()

spec = json.load(open(BOARD.split('.', 1)[0] + '.quads.json'))
pitch = spec['qOff'][1][0]
qcells = spec['quads'][spec['centreQuad']]['cells']
TILE_REFS = {f'SR{spec["centreQuad"]}'} | {f'{k}{c}' for c in qcells for k in 'UC'}
LADDER_W = 1.8 * pitch                   # stamp is 2*pitch wide; ladders span it


def tile_named(name):
    """PWM and coil nets are per-cell; DATA nets are per-quad."""
    m = re.match(r'(?:PWMA|PWMB|coil)_(\d+)', name)
    if m:
        return int(m.group(1)) in qcells
    m = re.match(r'DATA_(\d+)$', name)
    return bool(m) and int(m.group(1)) == spec['centreQuad']


def anchors(item):
    """Connection points in board mm (track ends; pad/via centre)."""
    if item.Type() in (pcbnew.PCB_TRACE_T, pcbnew.PCB_ARC_T):
        s, e = item.GetStart(), item.GetEnd()
        return [(s[0] / 1e6, s[1] / 1e6), (e[0] / 1e6, e[1] / 1e6)]
    p = item.GetPosition()
    return [(p[0] / 1e6, p[1] / 1e6)]


# One pass over the board: bucket every connected item by net.
by_net, pad_ref = {}, {}
for t in board.GetTracks():
    by_net.setdefault(t.GetNetCode(), []).append(t)
for f in board.GetFootprints():
    for p in f.Pads():
        by_net.setdefault(p.GetNetCode(), []).append(p)
        pad_ref[p.m_Uuid.AsString()] = f.GetReference()
by_net.pop(0, None)                      # netcode 0 = no net

candidates = [c for c, items in by_net.items()
              if tile_named(netname.get(c, ''))
              or any(pad_ref.get(it.m_Uuid.AsString()) in TILE_REFS
                     for it in items)]
print(f'{BOARD}: {board_unconnected} unconnected board-wide; '
      f'{len(candidates)} nets touch the tile  ({time.time()-t0:.0f}s)')


def clusters_of(items):
    """pcbnew's connectivity, walked item by item: lists of connected items."""
    byid = {it.m_Uuid.AsString(): it for it in items}
    seen, out = set(), []
    for it in items:
        u = it.m_Uuid.AsString()
        if u in seen:
            continue
        comp, queue = [], [u]
        seen.add(u)
        while queue:
            v = byid[queue.pop()]
            comp.append(v)
            for nb in list(conn.GetConnectedTracks(v)) + list(conn.GetConnectedPads(v)):
                nu = nb.m_Uuid.AsString()
                if nu in byid and nu not in seen:
                    seen.add(nu)
                    queue.append(nu)
        out.append(comp)
    return out


def mst_edges(point_sets):
    """Prim over clusters; edge = nearest anchor pair between two clusters."""
    trees = [cKDTree(np.array(ps)) for ps in point_sets]
    done, todo, edges = {0}, set(range(1, len(point_sets))), []
    while todo:
        best = None
        for i in done:
            for j in todo:
                d, idx = trees[j].query(np.array(point_sets[i]))
                k = int(np.argmin(d))
                if best is None or d[k] < best[0]:
                    best = (float(d[k]), point_sets[i][k],
                            point_sets[j][int(idx[k])], j)
        edges.append(best[:3])
        done.add(best[3])
        todo.discard(best[3])
    return edges


def tile_tapped(cluster):
    return any(pad_ref.get(it.m_Uuid.AsString()) in TILE_REFS for it in cluster)


result = []
for code in candidates:
    name = netname.get(code, f'#{code}')
    comps = clusters_of(by_net[code])
    if tile_named(name):                 # drop neighbours' bare fragments
        comps = [c for c in comps if tile_tapped(c)
                 or any(it.Type() == pcbnew.PCB_TRACE_T for it in c)]
    else:                                # lane net: only tile-tapped clusters
        comps = [c for c in comps if tile_tapped(c)]
    pts = [[a for it in comp for a in anchors(it)] for comp in comps]
    # seam-to-seam row ladders are interface-complete: merge them into one
    ladder = [ps for ps in pts
              if max(p[0] for p in ps) - min(p[0] for p in ps) >= LADDER_W]
    frags = [ps for ps in pts if ps not in ladder]
    n_ladder = len(ladder)
    if ladder:
        frags.insert(0, [p for ps in ladder for p in ps])
    if len(frags) < 2:
        continue
    edges = mst_edges(frags)
    result.append({'net': name, 'fragments': len(frags),
                   'ladders_merged': n_ladder,
                   'airwires': [{'len_mm': round(d, 3),
                                 'from': [round(v, 3) for v in a],
                                 'to': [round(v, 3) for v in b]}
                                for d, a, b in edges]})
result.sort(key=lambda r: r['net'])
n_air = sum(len(r['airwires']) for r in result)
print(f'tile airwires: {n_air} across {len(result)} nets  ({time.time()-t0:.0f}s)')
for r in result:
    print(f"   {r['net']:12s} {len(r['airwires'])} airwire(s), "
          f"{r['fragments']} fragments"
          + (f" ({r['ladders_merged']} ladders as one)" if r['ladders_merged'] else ''))

with open(OUT.rsplit('.', 1)[0] + '.json', 'w') as f:
    json.dump({'board': BOARD, 'window_mm': WIN,
               'tile_refs': sorted(TILE_REFS),
               'board_unconnected': board_unconnected,
               'tile_airwires': n_air, 'nets': result}, f, indent=1)

# ---- the picture: lightened copper, airwires on top, legend in the corner --
PALETTE = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf',
           '#e377c2', '#bcbd22', '#8c564b', '#7f7f7f', '#004488', '#994455']
base = Image.open(BASE).convert('RGB')
W, H = base.size
base = Image.blend(base, Image.new('RGB', base.size, 'white'), 0.72)

S = 2                                    # draw 2x, downscale: cheap antialias
ov = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
px = lambda p: ((p[0] - X1) / (X2 - X1) * W * S, (p[1] - Y1) / (Y2 - Y1) * H * S)
for i, r in enumerate(result):
    col = PALETTE[i % len(PALETTE)]
    for e in r['airwires']:
        a, b = px(e['from']), px(e['to'])
        d.line([a, b], fill=col, width=3 * S)
        for c in (a, b):
            R = 5 * S
            d.ellipse([c[0] - R, c[1] - R, c[0] + R, c[1] + R],
                      fill=col, outline='white', width=S)
ov = ov.resize((W, H), Image.LANCZOS)
img = Image.alpha_composite(base.convert('RGBA'), ov).convert('RGB')

d = ImageDraw.Draw(img)
FDIR = '/usr/share/fonts/truetype/dejavu/'
try:
    fb = ImageFont.truetype(FDIR + 'DejaVuSans-Bold.ttf', 26)
    fn = ImageFont.truetype(FDIR + 'DejaVuSansMono.ttf', 24)
except OSError:
    fb = fn = ImageFont.load_default()
title = f'{BOARD} — tile airwires (true ratsnest): {n_air} across {len(result)} nets'
sub = ('tile = centre quad by ownership; seam-to-seam lane ladders count as '
       'tied (spine) · front view')
rows = [(PALETTE[i % len(PALETTE)],
         f"{r['net']:<10s} {len(r['airwires'])} airwire(s)  "
         + ' · '.join(f"{e['len_mm']:g} mm" for e in r['airwires']))
        for i, r in enumerate(result)]
tw = max([d.textlength(title, fb), d.textlength(sub, fn)] +
         [40 + d.textlength(s, fn) for _, s in rows])
lh, pad = 34, 14
box = (pad, pad, pad * 3 + tw, pad * 3 + lh * (len(rows) + 2))
d.rectangle(box, fill=(255, 255, 255, 235), outline='#333333', width=2)
d.text((pad * 2, pad * 2), title, fill='#111111', font=fb)
d.text((pad * 2, pad * 2 + lh), sub, fill='#444444', font=fn)
for i, (col, s) in enumerate(rows):
    y = pad * 2 + lh * (i + 2)
    d.rectangle([pad * 2, y + 4, pad * 2 + 26, y + 24], fill=col)
    d.text((pad * 2 + 40, y), s, fill='#111111', font=fn)
img.save(OUT, optimize=True)
print(f'wrote {OUT}  ({W}x{H})  ({time.time()-t0:.0f}s)')
