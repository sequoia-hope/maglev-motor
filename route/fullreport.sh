#!/bin/bash
# Renders + measured facts for report/index.html, straight from the board file.
#   ./fullreport.sh <key>      (expects <key>.kicad_pcb, <key>.bare.kicad_pcb,
#                               <key>.assemble.json, <key>.drc.json from fullgate.sh,
#                               <key>.routed.kicad_pcb + <key>.pour.json from pour.py)
cd "$(dirname "$0")"; K=${1:-amzfull}; B=${BASE:-fabtile2}
python3 render2.py $K.kicad_pcb  9.6  9.9 116.6 116.3 report/full2-board.png 18 B.Cu,In12.Cu
python3 render2.py $K.kicad_pcb 59.5 53.5  83.5  72.5 report/full2-stamp.png 75
python3 render2.py $K.kicad_pcb  9.6  9.9  37.0  33.5 report/full2-nw.png 62
python3 render2.py $K.kicad_pcb 91.0 84.0 116.6 106.5 report/full2-header.png 62
python3 render2.py $K.kicad_pcb  9.6 91.0  40.0 116.3 report/full2-sw.png 62
# power: the rails on one winding layer, the header feed, and where the hover drop is lost
# (before = the routed board without the pour; both maps on the same scale)
WIND=In9.Cu python3 render2.py $K.kicad_pcb 59.5 53.5 83.5 72.5 report/power-rails.png 60 In9.Cu
LABEL=1 python3 render2.py $K.kicad_pcb 101.0 93.5 109.0 101.5 report/power-feed.png 130 B.Cu
MAP=report/power-before MAP_MV=${MAP_MV:-130} python3 powercheck.py $K.routed.kicad_pcb $K.power-before.json > /dev/null
MAP=report/power-after MAP_MV=${MAP_MV:-130} LIMIT_J=${LIMIT_J:-70} LIMIT_LOOP=${LIMIT_LOOP:-200} python3 powercheck.py $K.kicad_pcb $K.power.json > /dev/null
BASE=$B python3 ringcheck.py $K.kicad_pcb > $K.ringcheck.txt
python3 - "$K" "$B" <<'PY'
import json, re, subprocess, sys
from collections import Counter
import pcbnew
K, B = sys.argv[1:3]
a = json.load(open(f'{K}.assemble.json'))
d = json.load(open(f'{K}.drc.json'))
HARD = ('hole_to_hole', 'track_dangling')
errs = Counter(v['type'] for v in d.get('violations', []) if v['severity'] == 'error' or v['type'] in HARD)
warn = Counter(v['type'] for v in d.get('violations', []) if v['severity'] != 'error' and v['type'] not in HARD)
b = pcbnew.LoadBoard(f'{K}.kicad_pcb')
t, tb = open(f'{K}.kicad_pcb').read(), open(f'{K}.bare.kicad_pcb').read()
seg = lambda s: len(re.findall(r'^  \(segment ', s, re.M)); via = lambda s: len(re.findall(r'^  \(via ', s, re.M))
cc = subprocess.run(['node', 'coilcheck.mjs', f'{K}.kicad_pcb'], capture_output=True, text=True, env={**__import__('os').environ, 'VALIDATE_SKIP': '1'})
coilcheck = (cc.stdout + cc.stderr).strip().split('\n')[0]
tc = subprocess.run(['node', 'tilecheck.mjs', f'{K}.stamp', f'{K}.stamp.union.ses'], capture_output=True, text=True)
tile = 'TILES CLEAN' if 'TILES CLEAN' in tc.stdout else (tc.stdout.strip().split('\n')[-1] if tc.stdout.strip() else 'not run')
cl = subprocess.run(['python3', 'coilleads.py', f'{K}.bare.kicad_pcb', f'{K}.kicad_pcb', f'{B}.terminals.json'], capture_output=True, text=True).stdout.strip().split('\n')[0]
lay = Counter(m.group(1) for m in re.finditer(r'^  \(segment \(start [^)]*\) \(end [^)]*\) \(width 0\.1\) \(layer "([^"]+)"', t, re.M))
quads = a['stats']; rep = [r for r in a['report'] if 'g' in r]; nets = [r for r in a['report'] if 'net' in r]
out = {
  'board': f'{K}.kicad_pcb',
  'drc_errors': dict(errs), 'drc_warnings': dict(warn),
  'unconnected': b.GetConnectivity().GetUnconnectedCount(True),
  'coil_leads': cl, 'coilcheck': coilcheck, 'tilecheck': tile,
  'routed_segments': seg(t) - seg(tb), 'routed_vias': via(t) - via(tb),
  'tracks_by_layer': dict(sorted(lay.items(), key=lambda kv: -kv[1])),
  'stamp_paths': max(q['paths'] for q in quads),
  'quads_full_stamp': sum(1 for q in quads if q['kept'] == q['paths']),
  'kept_grid': [q['kept'] for q in quads], 'need_grid': [len(n) for n in a['need']],
  'patched_quads': len(rep), 'patched_ok': sum(1 for r in rep if r.get('ok')),
  'patch_jobs': sum(r.get('jobs', 0) for r in rep),
  'board_nets': [{'net': r['net'], 'ok': r.get('ok')} for r in nets],
  'power': json.load(open(f'{K}.power.json')), 'power_before': json.load(open(f'{K}.power-before.json')),
  'pour': {k: v for k, v in json.load(open(f'{K}.pour.json')).items() if k != 'tree'},
  'ringcheck': open(f'{K}.ringcheck.txt').read().strip(),
  'feed_barrels': re.findall(r'^feed .*$', open(f'{K}.log').read(), re.M) if __import__('os').path.exists(f'{K}.log') else [],
}
json.dump(out, open('report/full.json', 'w'), indent=1)
print(json.dumps({k: v for k, v in out.items() if k not in ('kept_grid', 'need_grid', 'board_nets', 'tracks_by_layer', 'power', 'power_before', 'pour')}, indent=1))
PY
