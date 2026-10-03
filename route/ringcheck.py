#!/usr/bin/env python3
"""Gate: no coil is encircled by poured power copper.

  ringcheck.py <board.kicad_pcb>      env: BASE (terminals.json key), CELL (mm, 0.05)

A closed ring of rail round a coil is a shorted turn. This takes every filled
power polygon on the board, on EVERY layer and BOTH nets, projects them onto
one plane (barrels join the layers, and the decoupling caps join the two nets
at PWM frequency, so a ring closed across layers or across nets is still a
ring), and floods the copper-free plane in from outside the board. A coil
whose winding annulus the flood cannot reach is encircled.

Thin tracks are not counted: a loop closed through a 0.1 mm track has tens of
times the resistance of a poured one, and the routed board is full of them
already. Exit 1 if any coil is ringed (or if the board has no pour at all).
"""
import json, math, os, re, sys
import numpy as np
from scipy import ndimage

board = sys.argv[1]
BASE = os.environ.get('BASE', 'fabtile2'); CELL = float(os.environ.get('CELL', 0.05))
t = open(board).read()
polys = []
for zm in re.finditer(r'^  \(zone \(net [1-9]\d*\)[\s\S]*?\n  \)\n', t, re.M):
    for fm in re.finditer(r'\(filled_polygon \(layer "[^"]+"\) \(pts((?:\s*\(xy [-\d.]+ [-\d.]+\))+)\)\)', zm.group(0)):
        polys.append(np.array([(float(a), float(b)) for a, b in re.findall(r'\(xy ([-\d.]+) ([-\d.]+)\)', fm.group(1))]))
if not polys: raise SystemExit('ringcheck: no pour on this board')
coils = json.load(open(f'{BASE}.terminals.json'))['coils']
x0 = min(p[:, 0].min() for p in polys) - 1; y0 = min(p[:, 1].min() for p in polys) - 1
nx = int((max(p[:, 0].max() for p in polys) + 1 - x0) / CELL) + 1; ny = int((max(p[:, 1].max() for p in polys) + 1 - y0) / CELL) + 1
cu = np.zeros((ny, nx), bool)
for P in polys:                                    # even-odd scanline fill (the polygons are fractured: no holes)
    xs, ys = P[:, 0], P[:, 1]; x2, y2 = np.roll(xs, -1), np.roll(ys, -1)
    one = np.zeros_like(cu)
    for j in range(max(0, int((ys.min() - y0) / CELL)), min(ny - 1, int((ys.max() - y0) / CELL) + 1) + 1):
        y = y0 + (j + 0.5) * CELL
        k = (ys <= y) != (y2 <= y)
        if not k.any(): continue
        xc = np.sort(xs[k] + (y - ys[k]) * (x2[k] - xs[k]) / (y2[k] - ys[k]))
        for a, b in zip(xc[0::2], xc[1::2]):
            i0 = max(0, int(math.ceil((a - x0) / CELL - 0.5))); i1 = min(nx - 1, int(math.floor((b - x0) / CELL - 0.5)))
            if i1 >= i0: one[j, i0:i1 + 1] ^= True
    cu |= one
# the flood moves in 4-connected steps through copper-free cells: a slit has to be
# genuinely open (it is four cells wide) and a neck of pour at the 0.1 mm minimum,
# two cells thick, cannot be leaked through diagonally
lab, n = ndimage.label(~cu)
outside = lab[0, 0]
ringed = []
for ci, (cx, cy) in enumerate(coils):
    r = 2.0                                        # inside the winding annulus: never poured
    pts = [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 12, endpoint=False)]
    # the header's feed patch legitimately covers part of one face: a coil is ringed
    # only if NONE of its annulus can be reached from outside
    if all(lab[int((y - y0) / CELL), int((x - x0) / CELL)] != outside for x, y in pts): ringed.append(ci)
print(f'ringcheck: {len(polys)} poured polygons, {cu.sum() * CELL * CELL:.0f} mm2 projected; '
      + (f'{len(ringed)} of {len(coils)} coils ENCIRCLED: {ringed[:20]}' if ringed else f'no coil of {len(coils)} is encircled'))
sys.exit(1 if ringed else 0)
