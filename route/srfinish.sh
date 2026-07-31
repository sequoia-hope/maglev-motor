#!/bin/bash
# Finish a swept SR candidate to a judged stamp: R3 cleanup of the R1/R2
# fails, last-wins union, merge onto the board, DRC, and a position-diff of
# the merged DRC against the candidate's OWN bare board (rim junk moves when
# fitOrNudge moves, so counts alone do not prove the routing added nothing).
#   ./srfinish.sh KEY          (after srsweep-one.sh KEY ... has run)
set -u
cd "$(dirname "$0")"
KEY=$1
FR="java -Xss1024m -Xmx8g -jar freerouting-2.2.4.jar"
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=20 FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=100

TODO=$(python3 -c "import json; print(','.join(json.load(open('$KEY.lanes.todo.json'))))")
DONE="VLOGIC_C,SDA_C,SCL_C,SCLK_C,RCLK_C,OE_N_C,DATA_W,DATA_E,GND_C,VBUS_C"
COILS_TODO=$(echo "$TODO" | tr ',' '\n' | grep '^coil' | paste -sd, -)
REST_TODO=$(echo "$TODO" | tr ',' '\n' | grep -v '^coil' | paste -sd, -)
fails () {
  node checkses.mjs $KEY.$1.pins.json $KEY.$1.ses 2>/dev/null | grep "SPLIT" | cut -d: -f1 \
    | grep -xF -f <(echo "$2" | tr ',' '\n') | paste -sd, -
}
REDO=$(echo "$(fails r1 "$COILS_TODO"),$(fails r2 "$REST_TODO")" | tr ',' '\n' | grep -v '^$' | paste -sd, -)
: > $KEY.r3.ses
if [ -n "$REDO" ]; then
  echo "== R3 cleanup of [$REDO]"
  SRS=$(python3 -c "import json; print(','.join(json.load(open('$KEY.lanes.srstub.json'))))")
  VALIDATE_SKIP=1 DONE_NETS="$DONE" TAPS=$KEY.lanes.taps.json CARRY_AS_KEEPOUT=1 \
  SES_CARRY="$KEY.lanes.ses,$KEY.r1.ses,$KEY.r2.ses" RESTRICT="$REDO" SR_STUBBED="$SRS" \
  CARRY_SKIP_NETS="$REDO" \
    node quadroute.mjs $KEY.kicad_pcb $KEY.r3.dsn > $KEY.r3.gen.log 2>&1 || exit 1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=5 \
  timeout 1800 $FR -de $KEY.r3.dsn -do $KEY.r3.ses -mp 200 > $KEY.r3.router.log 2>&1
  echo "R3 fails: $(fails r3 "$REDO")"
fi

echo "== union + merge + DRC"
python3 - <<PYEOF
import re, os, json
first = open('$KEY.lanes.ses').read()
head = first[:first.index('(network_out')]
per_net = {}
for f in ['$KEY.lanes.ses', '$KEY.r1.ses', '$KEY.r2.ses', '$KEY.r3.ses']:
    if not os.path.exists(f) or not os.path.getsize(f): continue
    t = open(f).read()
    routes = t[t.index('(network_out'):]
    here = {}
    for m in re.finditer(r'\(net "?([^\s")]+)"?[\s\S]*?\n      \)', routes):
        here.setdefault(m.group(1), []).append(m.group(0))
    todo = set(json.load(open('$KEY.lanes.todo.json')))
    for k, v in here.items():
        if f != '$KEY.lanes.ses' and k in todo:
            per_net.setdefault(k, [])
            per_net[k] = per_net[k] + v
        else:
            per_net[k] = v
blocks = [b for bs in per_net.values() for b in bs]
open('$KEY.union.ses', 'w').write(head + '(network_out\n' + '\n'.join(blocks) + '\n      )\n    )\n)\n')
print(len(blocks), 'net blocks unioned from', len(per_net), 'nets')
PYEOF
CQ=$(python3 -c "import json; print(json.load(open('$KEY.quads.json'))['centreQuad'])")
ALIAS=$(python3 -c "
cq=$CQ
base='VBUS_C=VBUS,GND_C=GND,VLOGIC_C=VLOGIC,VLOGIC_CW=VLOGIC,VLOGIC_CE=VLOGIC,SCLK_C=SCLK,RCLK_C=RCLK,OE_N_C=OE_N,SDA_C=SDA,SCL_C=SCL'
print(base + f',DATA_W=DATA_{cq},DATA_E=DATA_{cq+1}')")
NET_ALIAS="$ALIAS" VALIDATE_SKIP=1 node mkses.mjs $KEY.kicad_pcb $KEY.union.ses $KEY.merged.kicad_pcb | head -2
cp $KEY.kicad_dru $KEY.merged.kicad_dru; cp $KEY.kicad_pro $KEY.merged.kicad_pro
cp $KEY.kicad_dru $KEY.bare.kicad_dru 2>/dev/null; cp $KEY.kicad_pro $KEY.bare.kicad_pro 2>/dev/null
kicad-cli pcb drc --format json --severity-error -o $KEY.merged.drc.json $KEY.merged.kicad_pcb 2>&1 | tail -1
kicad-cli pcb drc --format json --severity-error -o $KEY.bare.drc.json $KEY.kicad_pcb 2>&1 | tail -1
python3 - <<PYEOF
import json
from collections import Counter
def load(p):
    d = json.load(open(p))
    errs = [v for v in d.get('violations', []) if v['severity'] == 'error']
    pos = sorted((v['type'], round(i['pos']['x'], 3), round(i['pos']['y'], 3))
                 for v in errs for i in v.get('items', [])[:1])
    return Counter(v['type'] for v in errs), pos
mc, mp = load('$KEY.merged.drc.json')
bc, bp = load('$KEY.bare.drc.json')
print('MERGED DRC:', dict(mc) or 'NONE')
print('BARE   DRC:', dict(bc) or 'NONE')
new = [p for p in mp if p not in set(bp)]
gone = [p for p in bp if p not in set(mp)]
print(f'position diff vs bare: {len(new)} new, {len(gone)} resolved')
for p in new[:10]: print('  NEW:', p)
PYEOF

echo "== final verdict (all quad connections, union copper)"
node checkses.mjs $KEY.r2.pins.json $KEY.union.ses 2>/dev/null | tail -4
