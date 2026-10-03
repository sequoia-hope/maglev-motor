#!/bin/bash
# Gates for a torus-routed stamp session: merge onto the bare board, tiling,
# coil self-shorts, KiCad DRC.   ./t2gate.sh <key> <session.ses>
cd "$(dirname "$0")"; K=$1; SES=$2; BASE=${BASE:-fabtile2}
for f in kicad_pcb kicad_dru kicad_pro quads.json kicad_pcb.coilcheck.json; do cp -p $BASE.$f $K.$f; done
cp "$SES" $K.union.ses 2>/dev/null
CQ=$(python3 -c "import json; print(json.load(open('$K.quads.json'))['centreQuad'])")
ALIAS="VBUS_C=VBUS,GND_C=GND,VLOGIC_C=VLOGIC,SCLK_C=SCLK,RCLK_C=RCLK,OE_N_C=OE_N,SDA_C=SDA,SCL_C=SCL,DATA_W=DATA_$CQ,DATA_E=DATA_$((CQ+1))"
NET_ALIAS="$ALIAS" node mkses.mjs $K.kicad_pcb $K.union.ses $K.merged.kicad_pcb | grep -v wrote
cp $K.kicad_dru $K.merged.kicad_dru; cp $K.kicad_pro $K.merged.kicad_pro
echo "== tilecheck"; node tilecheck.mjs $K $K.union.ses | tail -n +3 | head -12
echo "== coilcheck"; node coilcheck.mjs $K.merged.kicad_pcb 2>&1 | tail -6
echo "== DRC"; kicad-cli pcb drc --format json --severity-all -o $K.merged.drc.json $K.merged.kicad_pcb >/dev/null 2>&1
python3 - <<PY
import json
from collections import Counter
d=json.load(open('$K.merged.drc.json'))
# hole_to_hole is a WARNING in the generated project file but a hard fab rule:
# count it with the errors (two same-net vias 0.075 mm apart got through once)
HARD=('hole_to_hole','track_dangling')
viol=[v for v in d.get('violations',[]) if v['severity']=='error' or v['type'] in HARD]
c=Counter(v['type'] for v in viol)
d['violations']=viol
print('DRC errors:', dict(c) or 'NONE')
for v in d.get('violations',[])[:12]:
    p=v['items'][0]['pos']; print('  ',v['type'],round(p['x'],3),round(p['y'],3),'|',' / '.join(i['description'][:55] for i in v['items']))
PY
