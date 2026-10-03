#!/bin/bash
# Whole-board gates, NO rim exemption: KiCad DRC, coilcheck, true ratsnest.
#   ./fullgate.sh <key>     (expects <key>.kicad_pcb; rule files copied from BASE)
cd "$(dirname "$0")"; K=$1; BASE=${BASE:-fabtile2}
cp $BASE.kicad_dru $K.kicad_dru; cp $BASE.kicad_pro $K.kicad_pro
kicad-cli pcb drc --format json --severity-all -o $K.drc.json $K.kicad_pcb >/dev/null 2>&1
python3 - <<PY
import json
from collections import Counter
d=json.load(open('$K.drc.json'))
# hole_to_hole is a WARNING in the generated project file but a hard fab rule:
# count it with the errors (two same-net vias 0.075 mm apart got through once)
HARD=('hole_to_hole','track_dangling')
viol=[v for v in d.get('violations',[]) if v['severity']=='error' or v['type'] in HARD]
c=Counter(v['type'] for v in viol)
d['violations']=viol
print('DRC errors (whole board):', dict(c) or 'NONE')
for v in d.get('violations',[])[:int('${SHOW:-10}')]:
    p=v['items'][0]['pos']; print('  ',v['type'],round(p['x'],3),round(p['y'],3),'|',' / '.join(i['description'][:60] for i in v['items']))
PY
VALIDATE_SKIP=1 node coilcheck.mjs $K.kicad_pcb 2>&1 | tail -${SHOWC:-4}
python3 - <<PY
import pcbnew
b=pcbnew.LoadBoard('$K.kicad_pcb'); c=b.GetConnectivity()
print('true ratsnest (pcbnew): %d unconnected' % c.GetUnconnectedCount(True))
PY
