#!/usr/bin/env python3
"""Cut a window out of a kicad-cli SVG without re-plotting it.

`kicad-cli pcb export svg --page-size-mode 1` writes paths in BOARD
millimetres, one to one -- the page is just a viewport over them. So a zoom is
a header rewrite: set the viewBox to the window and SVG clips the rest. Doing
it this way keeps every crop pixel-exact against board coordinates, which
page-size-mode 2 does not (its origin is not the outline's, measured: a
106.13 mm board comes out 103.76 mm wide with the west edge off-canvas).

  svgwin.py <in.svg> <out.svg> x1 y1 x2 y2
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
x1, y1, x2, y2 = map(float, sys.argv[3:7])
w, h = x2 - x1, y2 - y1
txt = open(src).read()
txt = re.sub(
    r'width="[\d.]+mm" height="[\d.]+mm" viewBox="[-\d. ]+"',
    f'width="{w:.4f}mm" height="{h:.4f}mm" '
    f'viewBox="{x1:.4f} {y1:.4f} {w:.4f} {h:.4f}"',
    txt, count=1)
open(dst, 'w').write(txt)
