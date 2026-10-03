#!/usr/bin/env python3
"""Quick look at routed copper: pads, barrels and tracks from a .kicad_pcb
window, one colour per layer, drawn straight from the file (no kicad-cli).

  render2.py <board.kicad_pcb> x1 y1 x2 y2 out.png [px_per_mm] [layers,comma]

Windings are skipped (locked copper) unless WIND=1. Net names are printed on
pads when LABEL=1."""
import os, re, sys, math
from PIL import Image, ImageDraw, ImageFont
board = sys.argv[1]; x1, y1, x2, y2 = map(float, sys.argv[2:6]); out = sys.argv[6]
ppm = float(sys.argv[7]) if len(sys.argv) > 7 else 60
only = set(sys.argv[8].split(',')) if len(sys.argv) > 8 else None
t = open(board).read()
nets = {int(m.group(1)): m.group(2) for m in re.finditer(r'^  \(net (\d+) "([^"]*)"\)$', t, re.M)}
W, H = int((x2 - x1) * ppm), int((y2 - y1) * ppm)
SS = 2
img = Image.new('RGB', (W * SS, H * SS), 'white'); d = ImageDraw.Draw(img, 'RGBA')
P = lambda x, y: ((x - x1) * ppm * SS, (y - y1) * ppm * SS)
COL = {'B.Cu': (40, 90, 200), 'In12.Cu': (220, 60, 90), 'In11.Cu': (30, 160, 60), 'In10.Cu': (230, 140, 20),
       'In9.Cu': (150, 60, 200), 'In8.Cu': (0, 170, 170), 'In7.Cu': (140, 100, 40), 'In6.Cu': (200, 60, 200),
       'In5.Cu': (90, 140, 0), 'In4.Cu': (250, 100, 60), 'In3.Cu': (60, 60, 60), 'In2.Cu': (0, 100, 140),
       'In1.Cu': (170, 0, 60), 'F.Cu': (120, 120, 0)}
inwin = lambda x, y, m=1.0: x1 - m <= x <= x2 + m and y1 - m <= y <= y2 + m
if os.environ.get('WIND'):
    for m in re.finditer(r'^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\) \(locked\) \(layer "([^"]+)"\)', t, re.M):
        ax, ay, bx, by = map(float, m.group(1, 2, 3, 4))
        if m.group(6) != os.environ['WIND'] or not (inwin(ax, ay) or inwin(bx, by)): continue
        d.line([P(ax, ay), P(bx, by)], fill=(200, 200, 200, 255), width=max(1, int(float(m.group(5)) * ppm * SS)))
# power pours (pour.py): the filled polygons, in the net's colour, under everything
ZCOL = {'GND': (70, 150, 90), 'VBUS': (225, 120, 60)}
for zm in re.finditer(r'^  \(zone \(net \d+\) \(net_name "([^"]+)"\)[\s\S]*?\n  \)\n', t, re.M):
    for fm in re.finditer(r'\(filled_polygon \(layer "([^"]+)"\) \(pts((?:\s*\(xy [-\d.]+ [-\d.]+\))+)\)\)', zm.group(0)):
        if only and fm.group(1) not in only: continue
        pts = [(float(a), float(b)) for a, b in re.findall(r'\(xy ([-\d.]+) ([-\d.]+)\)', fm.group(2))]
        if not any(inwin(x, y) for x, y in pts): continue
        d.polygon([P(x, y) for x, y in pts], fill=ZCOL.get(zm.group(1), (150, 150, 150)) + (120,))
for m in re.finditer(r'  \(footprint "maglev:[^"]+" \(layer "[^"]+"\) \(at ([-\d.]+) ([-\d.]+)\)([\s\S]*?)\n  \)\n', t):
    fx, fy = float(m.group(1)), float(m.group(2))
    if not inwin(fx, fy, 3): continue
    ref = re.search(r'fp_text reference "([^"]+)"', m.group(3)).group(1)
    for p in re.finditer(r'\(pad "(\d+)" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\).*?\(net \d+ "([^"]*)"\)', m.group(3)):
        px, py = fx + float(p.group(2)), fy + float(p.group(3)); a = math.radians(float(p.group(4) or 0))
        w, h = float(p.group(5)) / 2, float(p.group(6)) / 2; ca, sa = math.cos(a), math.sin(a)
        pts = [P(px + sx * w * ca + sy * h * sa, py - sx * w * sa + sy * h * ca) for sx, sy in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
        d.polygon(pts, fill=(150, 170, 215, 255))
        if os.environ.get('LABEL'):
            d.text(P(px - w, py - 0.1), f"{ref}.{p.group(1)} {p.group(7)}", fill=(0, 0, 0, 255), font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', int(0.16 * ppm * SS)))
segs = []
for m in re.finditer(r'^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\) \(layer "([^"]+)"\) \(net (\d+)\)\)', t, re.M):
    ax, ay, bx, by = map(float, m.group(1, 2, 3, 4)); L = m.group(6)
    if only and L not in only: continue
    if not (inwin(ax, ay) or inwin(bx, by)): continue
    if nets[int(m.group(7))].startswith('coil_') and L not in ('B.Cu', 'In12.Cu') and not os.environ.get('TABS'): continue
    segs.append((L, ax, ay, bx, by, float(m.group(5))))
order = ['F.Cu'] + [f'In{k}.Cu' for k in range(1, 13)] + ['B.Cu']
for L in order:
    c = COL[L]
    for (l, ax, ay, bx, by, w) in segs:
        if l != L: continue
        wd = max(1, int(w * ppm * SS)); a, b = P(ax, ay), P(bx, by)
        d.line([a, b], fill=c + (215,), width=wd)
        for q in (a, b): d.ellipse([q[0] - wd / 2, q[1] - wd / 2, q[0] + wd / 2, q[1] + wd / 2], fill=c + (215,))
for m in re.finditer(r'^  \(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill ([\d.]+)\) \(layers "F.Cu" "B.Cu"\) \(net (\d+)\)', t, re.M):
    x, y, s, dr = map(float, m.group(1, 2, 3, 4))
    if not inwin(x, y): continue
    n = nets[int(m.group(5))]
    col = (120, 120, 120, 255) if n.startswith('coil_') else (20, 20, 20, 255)
    a = P(x, y); r = s / 2 * ppm * SS; r2 = dr / 2 * ppm * SS
    d.ellipse([a[0] - r, a[1] - r, a[0] + r, a[1] + r], outline=col, width=max(2, int(0.05 * ppm * SS)))
    d.ellipse([a[0] - r2, a[1] - r2, a[0] + r2, a[1] + r2], fill=(255, 255, 255, 255), outline=col)
for m in re.finditer(r'\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)', t):
    ax, ay, bx, by = map(float, m.groups())
    if inwin(ax, ay, 5) or inwin(bx, by, 5): d.line([P(ax, ay), P(bx, by)], fill=(0, 0, 0, 255), width=3)
img = img.resize((W, H), Image.LANCZOS); img.save(out)
print(out, W, H)
