#!/usr/bin/env python3
"""Lock every track, via and footprint that is NOT the centre stamp's own
routed copper, and save the result as the hand-routing board.

The lock flag is the ownership marker for the whole hand loop: handses.py
extracts exactly the UNLOCKED tracks/vias, so after this pass

  unlocked  == the stamp's routed copper (yours to edit, rip up, replace)
  locked    == the generated board (windings, tabs, coil/seam vias, parts)
               + the 8 neighbouring stamp images (handimages.mjs)

Moving locked copper would either break the 42x stamp identity (bare-board
items exist once per cell and are placed by the generator) or desynchronise
the images from tilecheck's ground truth -- pcbnew refuses to drag locked
items, which is the point.

  handlock.py <in.kicad_pcb> <ses[,more]> <out.kicad_pcb>

Stamp copper is recognised by exact geometry match against the ses: session
coordinates are integers in 0.1 um, mkses writes them at 1e-6 mm, pcbnew
stores integer nm -- the round trip is exact, so the match is a set lookup.
"""
import re
import sys

import pcbnew

inp, sess, outp = sys.argv[1], sys.argv[2], sys.argv[3]

segkeys, viakeys = set(), set()
for sp in sess.split(','):
    t = open(sp).read()
    m = re.search(r'\(resolution (\w+) (\d+)\)', t)
    unit, div = (m.group(1), int(m.group(2))) if m else ('um', 10)
    npu = (1000 if unit == 'um' else 1e6) / div          # nm per session unit
    routes = t[t.index('(network_out'):]
    for nm in re.finditer(r'\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)', routes):
        body = nm.group(2)
        for w in re.finditer(r'\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)', body):
            layer = w.group(1)
            nums = [int(v) for v in w.group(3).split()]
            for i in range(0, len(nums) - 3, 2):
                x0, y0, x1, y1 = nums[i:i + 4]
                if (x0, y0) == (x1, y1):
                    continue
                a = (round(x0 * npu), round(-y0 * npu))
                b = (round(x1 * npu), round(-y1 * npu))
                segkeys.add((layer, a, b))
                segkeys.add((layer, b, a))
        for v in re.finditer(r'\(via \S+((?:\s+-?\d+){2})\s*\)', body):
            x, y = [int(q) for q in v.group(1).split()]
            viakeys.add((round(x * npu), round(-y * npu)))

board = pcbnew.LoadBoard(inp)
locked = unlocked = 0
hit_segs, hit_vias = set(), set()
for t in board.GetTracks():
    if isinstance(t, pcbnew.PCB_VIA):
        k = (t.GetPosition().x, t.GetPosition().y)
        free = k in viakeys
        if free:
            hit_vias.add(k)
    else:  # PCB_TRACK and PCB_ARC (the stamp ses has no arcs; arcs stay locked)
        layer = board.GetLayerName(t.GetLayer())
        k = (layer, (t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y))
        free = not isinstance(t, pcbnew.PCB_ARC) and k in segkeys
        if free:
            hit_segs.add(k)
            hit_segs.add((layer, k[2], k[1]))
    t.SetLocked(not free)
    if free:
        unlocked += 1
    else:
        locked += 1
for fp in board.GetFootprints():
    fp.SetLocked(True)

pcbnew.SaveBoard(outp, board)
miss_s = len(segkeys) - len(hit_segs)
miss_v = len(viakeys) - len(hit_vias)
print(f'{unlocked} stamp items left unlocked, {locked} items locked, '
      f'{len(board.GetFootprints())} footprints locked')
if miss_s or miss_v:
    # mkses may legitimately drop a shared-copper net; anything else is a bug
    print(f'WARNING: {miss_s // 2} ses segment keys and {miss_v} via keys '
          f'have no board copper (mkses dropped or merged them?)')
print(f'wrote {outp}')
