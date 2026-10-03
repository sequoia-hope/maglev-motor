#!/usr/bin/env python3
"""Every bridge output must reach ITS OWN coil terminal and nothing else.

A coil's two leads are one KiCad net (the winding joins them), so no DRC and no
ratsnest can tell "OUTA wired to the IN terminal" from "OUTA wired straight to
OUTB" or from "OUTA landed on a mid-winding crossover via". This walks only the
ROUTED copper of each coil net (everything the bare board did not have) and
checks, per coil:  U.2 -> IN terminal barrel,  U.6 -> OUT terminal barrel, the
two lead trees share nothing, and neither touches any other barrel of the coil.

  coilleads.py <bare.kicad_pcb> <routed.kicad_pcb> <terminals.json>
terminals.json: {"IN": [dx, dy], "OUT": [dx, dy], "coils": [[x, y], ...]} (file frame)
"""
import json, math, re, sys
from collections import defaultdict
bare, routed, term = sys.argv[1:4]
T = json.load(open(term))
SEG = re.compile(r'^  \(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(width ([\d.]+)\)(?: \(locked\))? \(layer "([^"]+)"\) \(net (\d+)\)\)', re.M)
VIA = re.compile(r'^  \(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill [\d.]+\) \(layers "[^"]+" "[^"]+"\) \(net (\d+)\)\)', re.M)
tb, tr = open(bare).read(), open(routed).read()
nets = {int(m.group(1)): m.group(2) for m in re.finditer(r'^  \(net (\d+) "([^"]*)"\)$', tr, re.M)}
bare_segs = set(m.group(0) for m in SEG.finditer(tb)); bare_vias = set(m.group(0) for m in VIA.finditer(tb))
segs = defaultdict(list); vias = defaultdict(list); newvias = defaultdict(list)
for m in SEG.finditer(tr):
    n = nets[int(m.group(7))]
    if n.startswith('coil_') and m.group(0) not in bare_segs:
        segs[n].append((float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)), m.group(6)))
for m in VIA.finditer(tr):
    n = nets[int(m.group(4))]
    if not n.startswith('coil_'): continue
    (vias if m.group(0) in bare_vias else newvias)[n].append((float(m.group(1)), float(m.group(2)), float(m.group(3)) / 2))
pads = defaultdict(dict)
for m in re.finditer(r'  \(footprint "maglev:[^"]+" \(layer "[^"]+"\) \(at ([-\d.]+) ([-\d.]+)\)([\s\S]*?)\n  \)\n', tr):
    for p in re.finditer(r'\(pad "(\d+)" smd rect \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\) \(size ([\d.]+) ([\d.]+)\).*?\(net \d+ "(coil_\d+)"\)', m.group(3)):
        pads[p.group(7)][p.group(1)] = (float(m.group(1)) + float(p.group(2)), float(m.group(2)) + float(p.group(3)), float(p.group(4) or 0), float(p.group(5)), float(p.group(6)))
def in_pad(x, y, pd, grow=0.0):
    px, py, deg, w, h = pd; a = math.radians(deg); dx, dy = x - px, y - py
    lx, ly = dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)
    return abs(lx) <= w / 2 + grow and abs(ly) <= h / 2 + grow
def pt_seg(px, py, s):
    ax, ay, bx, by = s[:4]; vx, vy = bx - ax, by - ay; L = vx * vx + vy * vy
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / L)) if L > 1e-12 else 0
    return math.hypot(px - ax - t * vx, py - ay - t * vy)
bad = []; ok = 0
for ci, (cx, cy) in enumerate(T['coils']):
    net = f'coil_{ci}'; S = segs.get(net, []); P = pads.get(net, {})
    tin = (cx + T['IN'][0], cy + T['IN'][1]); tout = (cx + T['OUT'][0], cy + T['OUT'][1])
    def is_term(v): return 'IN' if math.hypot(v[0] - tin[0], v[1] - tin[1]) < 0.05 else 'OUT' if math.hypot(v[0] - tout[0], v[1] - tout[1]) < 0.05 else None
    # union-find over routed segments: shared end, end on body (same layer), or a new via stitching layers
    par = list(range(len(S)))
    def find(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    for i, s in enumerate(S):
        for j in range(i):
            u = S[j]
            near = False
            for (x, y) in ((s[0], s[1]), (s[2], s[3])):
                if s[4] == u[4] and pt_seg(x, y, u) < 0.051: near = True
                if any(math.hypot(x - v[0], y - v[1]) < 0.26 and min(pt_seg(v[0], v[1], u), 9) < 0.26 for v in newvias.get(net, [])): near = True
            for (x, y) in ((u[0], u[1]), (u[2], u[3])):
                if s[4] == u[4] and pt_seg(x, y, s) < 0.051: near = True
            if near: par[find(i)] = find(j)
    trees = defaultdict(lambda: {'pads': set(), 'terms': set(), 'other': 0})
    for i, s in enumerate(S):
        tinfo = trees[find(i)]
        for name, pd in P.items():
            if s[4] == 'B.Cu' and (in_pad(s[0], s[1], pd) or in_pad(s[2], s[3], pd)): tinfo['pads'].add(name)
        for v in vias.get(net, []):
            if pt_seg(v[0], v[1], s) < v[2] + 0.05 - 1e-6:
                k = is_term(v)
                if k: tinfo['terms'].add(k)
                else: tinfo['other'] += 1
    got = {frozenset(t['pads']): t for t in trees.values()}
    a = next((t for t in trees.values() if '2' in t['pads']), None); b = next((t for t in trees.values() if '6' in t['pads']), None)
    why = []
    if not a or a['terms'] != {'IN'} or a['pads'] != {'2'}: why.append(f"U.2 tree: pads {sorted(a['pads']) if a else None} terminals {sorted(a['terms']) if a else None}")
    if not b or b['terms'] != {'OUT'} or b['pads'] != {'6'}: why.append(f"U.6 tree: pads {sorted(b['pads']) if b else None} terminals {sorted(b['terms']) if b else None}")
    if any(t['other'] for t in trees.values()): why.append('routed copper touches a mid-winding barrel')
    if a is not None and a is b: why.append('both bridge outputs on ONE routed tree (coil bypassed)')
    if why: bad.append((ci, why))
    else: ok += 1
print(f'coil leads: {ok}/{len(T["coils"])} coils correct (U.2 -> IN terminal, U.6 -> OUT terminal, trees separate)')
for ci, why in bad[:20]: print(f'  coil_{ci}: ' + '; '.join(why))
sys.exit(1 if bad else 0)
