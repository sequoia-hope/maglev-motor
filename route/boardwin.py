#!/usr/bin/env python3
"""Cut a rectangular window out of a generated board.

`kicad-cli` always plots the whole board, so a zoomed render of one cell still
costs a 24 MB SVG of 300 000 spiral segments and minutes of rasterising. This
throws the copper away first: keep only the items whose coordinates fall in the
window (plus a margin, so a part straddling the edge still draws), and replace
the outline with the window rectangle so the plot has something to frame.

Only for RENDERING. The result is not a board -- it has nets whose copper is
half gone -- so never DRC it or hand it to a router.

  boardwin.py <in.kicad_pcb> <out.kicad_pcb> x1 y1 x2 y2 [margin_mm]
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
x1, y1, x2, y2 = map(float, sys.argv[3:7])
M = float(sys.argv[7]) if len(sys.argv) > 7 else 3.0
lo_x, hi_x, lo_y, hi_y = x1 - M, x2 + M, y1 - M, y2 + M

NUM = re.compile(r'-?\d+\.?\d*')
ITEM = re.compile(r'^  \((segment|arc|via|gr_line|gr_arc|gr_rect|gr_circle|gr_poly|gr_text)\b')
AT = re.compile(r'\(at (-?\d+\.?\d*) (-?\d+\.?\d*)')


def hits(pairs):
    return any(lo_x <= x <= hi_x and lo_y <= y <= hi_y for x, y in pairs)


def coords(line):
    """(x, y) pairs from the position fields only -- widths and layer names
    must not be read as geometry."""
    out = []
    for m in re.finditer(r'\((?:start|mid|end|at|center|xy) '
                         r'(-?\d+\.?\d*) (-?\d+\.?\d*)', line):
        out.append((float(m.group(1)), float(m.group(2))))
    return out


lines = open(src).read().split('\n')
out, i, dropped, kept = [], 0, 0, 0
edge_at = None
while i < len(lines):
    ln = lines[i]
    if ln.startswith('  (footprint '):
        j = i
        while j < len(lines) and lines[j] != '  )':
            j += 1
        m = AT.search(ln)
        if m and hits([(float(m.group(1)), float(m.group(2)))]):
            out.extend(lines[i:j + 1]); kept += 1
        else:
            dropped += 1
        i = j + 1
        continue
    m = ITEM.match(ln)
    if m:
        if 'Edge.Cuts' in ln:
            if edge_at is None:
                edge_at = len(out)
            dropped += 1
        elif hits(coords(ln)):
            out.append(ln); kept += 1
        else:
            dropped += 1
        i += 1
        continue
    out.append(ln)
    i += 1

rect = [f'  (gr_line (start {a} {b}) (end {c} {d}) '
        f'(layer "Edge.Cuts") (width 0.05))'
        for a, b, c, d in [(x1, y1, x2, y1), (x2, y1, x2, y2),
                           (x2, y2, x1, y2), (x1, y2, x1, y1)]]
out[edge_at if edge_at is not None else len(out) - 1:
    edge_at if edge_at is not None else len(out) - 1] = rect
open(dst, 'w').write('\n'.join(out))
print(f'{dst}: {kept} items kept, {dropped} dropped '
      f'({x2 - x1:.1f} x {y2 - y1:.1f} mm at {x1},{y1}, margin {M})')
