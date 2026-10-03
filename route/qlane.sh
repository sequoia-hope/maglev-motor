#!/bin/bash
# The CONSTRUCTED-LANE quad pipeline (single-cell-periodic-routing, lane-stage
# diagnosis): freerouting sprawls over whatever board it is given first and
# every carry mode composes badly, so the bus lanes -- straight by ladder-v3
# design -- are CONSTRUCTED by lanegen.mjs and only ONE routed stage remains:
# locals + power + register drops, negotiated together, with the constructed
# copper as keepouts. Then union, merge, DRC-gate the stamp.
#   ./qlane.sh            (env: SKIP_GEN=1 to reuse the existing board,
#                                OUT_KEY=<name> to write <name>.* instead of qlane.*,
#                                FABRIC_LAYERS=In11.Cu,In10.Cu,In9.Cu,In8.Cu,In7.Cu,In6.Cu
#                                for the winding-layer fabric -- six layers
#                                carry the band-NN staircase; see lanegen.mjs,
#                                MP_R1/MP_R2/MP_R3 for the router pass budgets,
#                                PERIODIC_KEEPOUTS=1 so the routed stage sees
#                                the neighbouring stamps too)
cd "$(dirname "$0")"
B=${OUT_KEY:-qlane}
exec > >(tee "$B.log") 2>&1
echo "== $B start $(date)"
FR="java -Xss1024m -Xmx8g -jar freerouting-2.2.4.jar"
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=20 FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=100

if [ -z "$SKIP_GEN" ]; then
  echo "== regenerate (ladder v3 + banFlats/banBands, pinned placements)"
  # The constructed combs/harness are hand-measured against THESE part
  # positions; letting the placement search re-run against moved crossover
  # vias shifts U/C/SR ~0.1 mm and every tooth misses its pad. rdeg 180 on
  # U = pads 1/3 EAST (rdeg 0 mirrors the columns and the combs miss).
  U_AT="1.493,2.396,180" C_AT="2.093,0.596,0" SR_AT="-0.707,-1.204,330" \
  OUT_KEY=$B node quadgen.mjs amzhex || exit 1
fi

echo "== validate generated board (coilcheck gate)"
node coilcheck.mjs $B.kicad_pcb || { echo "COILCHECK FAILED -- fix the generator before routing"; exit 1; }

echo "== construct lanes"
node lanegen.mjs $B.kicad_pcb $B.lanes.ses || exit 1

CQ=$(python3 -c "import json; print(json.load(open('$B.quads.json'))['centreQuad'])")
# lanegen constructs everything it can (lanes, power combs, coils, drops,
# PWM harness); whatever its A* could not fit is listed in $B.lanes.todo.json
# and goes to freerouting, which unlike the B.Cu-only constructor can hop to
# the EMPTY inter-row In12 through gutter vias. CARRY_SKIP_NETS keeps the
# fallback nets' own stubs out of their way; last-wins union drops the stubs.
TODO=$(python3 -c "import json; print(','.join(json.load(open('$B.lanes.todo.json'))))")
DONE="VLOGIC_C,SDA_C,SCL_C,SCLK_C,RCLK_C,OE_N_C,DATA_W,DATA_E,GND_C,VBUS_C"

SR_STUBBED=$(python3 -c "import json; print(','.join(json.load(open('$B.lanes.srstub.json'))))")
run_stage () {  # $1 name  $2 restrict  $3 carry list  $4 mp  [$5 skip-nets]
  DONE_NETS="$DONE" TAPS=$B.lanes.taps.json CARRY_AS_KEEPOUT=1 SES_CARRY="$3" \
  CARRY_SKIP_NETS="${5:-}" RESTRICT="$2" SR_STUBBED="$SR_STUBBED" \
    node quadroute.mjs $B.kicad_pcb $B.$1.dsn > $B.$1.gen.log || exit 1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=5 \
  timeout 3600 $FR -de $B.$1.dsn -do $B.$1.ses -mp $4 > $B.$1.router.log 2>&1
  grep "session completed" $B.$1.router.log | sed 's/.*final/final/;s/, using.*//'
  [ -s $B.$1.ses ] || { echo "stage $1 NO SESSION"; exit 1; }
}
fails () {  # failed nets of stage $1, restricted to its own nets $2
  node checkses.mjs $B.$1.pins.json $B.$1.ses 2>/dev/null | grep "SPLIT" | cut -d: -f1 \
    | grep -xF -f <(echo "$2" | tr ',' '\n') | paste -sd, -
}

COILS_TODO=$(echo "$TODO" | tr ',' '\n' | grep '^coil' | paste -sd, -)
REST_TODO=$(echo "$TODO" | tr ',' '\n' | grep -v '^coil' | paste -sd, -)
: > $B.r1.ses; : > $B.r2.ses; : > $B.r3.ses
if [ -n "$COILS_TODO" ]; then
  echo "== stage R1: coils [$COILS_TODO] (mp ${MP_R1:-100}, vc 5)"
  run_stage r1 "$COILS_TODO" "$B.lanes.ses" "${MP_R1:-100}"
  echo "R1 fails: $(fails r1 "$COILS_TODO")"
fi
if [ -n "$REST_TODO" ]; then
  echo "== stage R2: register pocket [$REST_TODO] (mp ${MP_R2:-300}, vc 5)"
  run_stage r2 "$REST_TODO" "$B.lanes.ses,$B.r1.ses" "${MP_R2:-300}"
  echo "R2 fails: $(fails r2 "$REST_TODO")"
fi
REDO=$(echo "$(fails r1 "$COILS_TODO"),$(fails r2 "$REST_TODO")" | tr ',' '\n' | grep -v '^$' | paste -sd, -)
if [ -n "$REDO" ]; then
  echo "== stage R3: cleanup of [$REDO] (mp ${MP_R3:-200}, vc 5)"
  run_stage r3 "$REDO" "$B.lanes.ses,$B.r1.ses,$B.r2.ses" "${MP_R3:-200}" "$REDO"
  echo "R3 fails: $(fails r3 "$REDO")"
fi

echo "== union + merge + DRC gate"
python3 - <<PYEOF
import re, os, json
first = open('$B.lanes.ses').read()
head = first[:first.index('(network_out')]
# LAST file wins per net: a cleanup stage re-routes nets whose earlier
# fragments must not merge alongside the good copper.
per_net = {}
for f in ['$B.lanes.ses', '$B.r1.ses', '$B.r2.ses', '$B.r3.ses']:
    if not os.path.getsize(f): continue
    t = open(f).read()
    routes = t[t.index('(network_out'):]
    here = {}
    for m in re.finditer(r'\(net "?([^\s")]+)"?[\s\S]*?\n      \)', routes):
        here.setdefault(m.group(1), []).append(m.group(0))
    todo = set(json.load(open('$B.lanes.todo.json')))
    for k, v in here.items():
        if f != '$B.lanes.ses' and k in todo:
            per_net.setdefault(k, [])
            per_net[k] = per_net[k] + v          # append: constructed + routed
        else:
            per_net[k] = v                       # last file wins
blocks = [b for bs in per_net.values() for b in bs]
open('$B.union.ses', 'w').write(head + '(network_out\n' + '\n'.join(blocks) + '\n      )\n    )\n)\n')
print(len(blocks), 'net blocks unioned from', len(per_net), 'nets')
PYEOF
ALIAS=$(python3 -c "
cq=$CQ
base='VBUS_C=VBUS,GND_C=GND,VLOGIC_C=VLOGIC,VLOGIC_CW=VLOGIC,VLOGIC_CE=VLOGIC,SCLK_C=SCLK,RCLK_C=RCLK,OE_N_C=OE_N,SDA_C=SDA,SCL_C=SCL'
print(base + f',DATA_W=DATA_{cq},DATA_E=DATA_{cq+1}')")
NET_ALIAS="$ALIAS" node mkses.mjs $B.kicad_pcb $B.union.ses $B.merged.kicad_pcb | head -2
cp $B.kicad_dru $B.merged.kicad_dru; cp $B.kicad_pro $B.merged.kicad_pro
kicad-cli pcb drc --format json --severity-error -o $B.merged.drc.json $B.merged.kicad_pcb 2>&1 | tail -1
python3 -c "
import json
from collections import Counter
d=json.load(open('$B.merged.drc.json'))
c=Counter(v['type'] for v in d.get('violations',[]) if v['severity']=='error')
print('SINGLE-QUAD DRC ERRORS:', dict(c) or 'NONE')"
# The stamp is only useful if it REPEATS: DRC on this board says the copper is
# legal where it sits, which is a different question from whether 42 copies of
# it collide. tilecheck answers that one, and it is the gate between a routed
# cell and a routed board.
echo "== tiling gate"
node tilecheck.mjs $B $B.union.ses | tail -n +2
echo "== $B done $(date)"
