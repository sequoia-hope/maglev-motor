#!/usr/bin/env python3
"""What is still unconnected, by net: pcbnew's own clusters.  openlist.py <board> [-v]"""
import sys, pcbnew, collections
b = pcbnew.LoadBoard(sys.argv[1]); conn = b.GetConnectivity()
uid = lambda i: i.m_Uuid.AsString()
by = collections.defaultdict(list); ref = {}
for t in b.GetTracks():
    if t.GetNetname().startswith('coil_') and t.IsLocked(): continue
    by[t.GetNetname()].append(t)
for f in b.GetFootprints():
    for p in f.Pads():
        by[p.GetNetname()].append(p); ref[uid(p)] = f'{f.GetReference()}.{p.GetNumber()}'
by.pop('', None)
tot = 0; rows = []
for name, items in by.items():
    if name.startswith('coil_'):
        # a coil is closed when both bridge pads reach the winding: count pads with no copper at all
        lone = [ref[uid(i)] for i in items if uid(i) in ref and not list(conn.GetConnectedTracks(i))]
        if lone: rows.append((name, len(lone), 'bare pads ' + ' '.join(lone))); tot += len(lone)
        continue
    byid = {uid(i): i for i in items}; seen = set(); cl = []
    for it in items:
        u = uid(it)
        if u in seen: continue
        q = [u]; seen.add(u); comp = []
        while q:
            v = byid[q.pop()]; comp.append(v)
            for nb in list(conn.GetConnectedTracks(v)) + list(conn.GetConnectedPads(v)):
                nu = uid(nb)
                if nu in byid and nu not in seen: seen.add(nu); q.append(nu)
        cl.append(comp)
    if len(cl) > 1:
        cl.sort(key=len, reverse=True)
        def desc(c):
            pads = [ref[uid(i)] for i in c if uid(i) in ref]
            p = c[0].GetPosition()
            return (' '.join(pads[:4]) if pads else f'{len(c)} tracks/vias') + f' @({p[0]/1e6:.1f},{p[1]/1e6:.1f})'
        rows.append((name, len(cl) - 1, ' | '.join(desc(c) for c in cl[1:6]))); tot += len(cl) - 1
print(f'{tot} open connections in {len(rows)} nets; pcbnew ratsnest says {conn.GetUnconnectedCount(True)}')
for name, n, d in sorted(rows): print(f'  {name:10s} {n:3d}  {d[:150]}')
