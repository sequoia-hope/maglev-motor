#!/usr/bin/env python3
"""Read a kicad-cli DRC json and say, in one screen, whether the board is
manufacturable and whether it is finished.

Two numbers matter and they are different things:
  * violations  -- does the copper break a JLCPCB rule (fab-blocking)
  * unconnected -- is any net still unrouted (design-incomplete)
A board can be perfectly manufacturable and half-routed; say so plainly.
"""
import collections
import json
import sys

path = sys.argv[1]
d = json.load(open(path))

# kicad-cli caps the unconnected list in its report, so the true count comes
# from the board's own connectivity graph.
true_unconnected = None
if len(sys.argv) > 2:
    try:
        import pcbnew
        b = pcbnew.LoadBoard(sys.argv[2])
        cn = b.GetConnectivity()
        cn.RecalculateRatsnest()
        true_unconnected = cn.GetUnconnectedCount(True)
    except Exception as e:                      # noqa: BLE001 - advisory only
        print(f'(could not read connectivity: {e})')

errs = [v for v in d.get('violations', []) if v.get('severity') == 'error']
warns = [v for v in d.get('violations', []) if v.get('severity') == 'warning']
unc = d.get('unconnected_items', [])


def net_of(v):
    desc = v['items'][0]['description']
    return desc.split('[')[1].split(']')[0] if '[' in desc else '?'


def klass(n):
    for p in ('PWMA_', 'PWMB_', 'coil_', 'DATA_', 'SDA_'):
        if n.startswith(p):
            return p.rstrip('_') + '_*'
    return n


print(f'DRC        : {len(errs)} errors, {len(warns)} warnings')
if errs:
    for t, n in collections.Counter(v['type'] for v in errs).most_common():
        print(f'   error    {n:5d}  {t}')
    seen = set()
    for v in errs:
        if v['type'] in seen:
            continue
        seen.add(v['type'])
        print(f'     e.g.   {v["description"]}')
if warns:
    for t, n in collections.Counter(v['type'] for v in warns).most_common():
        print(f'   warning  {n:5d}  {t}')

shown = len(unc)
total = true_unconnected if true_unconnected is not None else shown
print(f'Unrouted   : {total} connections' + (f'  (report lists {shown})' if shown != total else ''))
if unc:
    for k, n in collections.Counter(klass(net_of(v)) for v in unc).most_common(15):
        print(f'            {n:5d}  {k}')
