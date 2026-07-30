#!/bin/bash
# The OVERNIGHT quad pipeline: regenerate the quad board (worst-PWM register
# cost), route it in stages (locals -> power -> lanes), verify each stage
# geometrically, DRC the merged single quad BEFORE cloning (the lesson from
# round one: a dirty stamp clones its defects 42x), then clone to all 42 quads,
# DRC the full board and render it. Everything logs to quadnight.log.
cd "$(dirname "$0")"
exec > >(tee quadnight.log) 2>&1
echo "== quadnight start $(date)"
B=quadnight
VC=20 RC=100
FR="java -Xss512m -Xmx8g -jar freerouting-2.2.4.jar"
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=$VC FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=$RC

echo "== regenerate"
OUT_KEY=$B node quadgen.mjs amzhex || exit 1

LOCALS=$(python3 -c "
import json
s=json.load(open('$B.quads.json'))
c=s['quads'][s['centreQuad']]['cells']
print(','.join(f'coil_{i}_A,coil_{i}_B,PWMA_{i},PWMB_{i}' for i in c))")
CQ=$(python3 -c "import json; print(json.load(open('$B.quads.json'))['centreQuad'])")

echo "== stage 1: locals (mp 150)"
RESTRICT="$LOCALS" node quadroute.mjs $B.kicad_pcb $B.q1.dsn > /dev/null || exit 1
timeout 7200 $FR -de $B.q1.dsn -do $B.q1.ses -mp 150 | grep "session completed" | sed 's/.*final/final/;s/, using.*//'
[ -s $B.q1.ses ] || { echo "stage1 NO SESSION"; exit 1; }
node checkses.mjs $B.q1.pins.json $B.q1.ses --quiet | tail -2

echo "== stage 2: +power (keepout-carry, mp 60)"
CARRY_AS_KEEPOUT=1 SES_CARRY=$B.q1.ses RESTRICT="GND_C,VBUS_C" \
  node quadroute.mjs $B.kicad_pcb $B.q2.dsn > /dev/null || exit 1
timeout 14400 $FR -de $B.q2.dsn -do $B.q2.ses -mp 60 | grep "session completed" | sed 's/.*final/final/;s/, using.*//'
[ -s $B.q2.ses ] || { echo "stage2 NO SESSION"; exit 1; }
node checkses.mjs $B.q2.pins.json $B.q2.ses --quiet | tail -2

echo "== stage 3: lanes (keepout-carry of stages 1+2, mp 120)"
# carry BOTH previous sessions as keepouts: concatenate their copper by
# feeding stage2's session (which does NOT contain stage1 copper -- keepout
# mode strips it) -- so pass both files through SES_CARRY as a comma list.
CARRY_AS_KEEPOUT=1 SES_CARRY="$B.q1.ses,$B.q2.ses" \
  RESTRICT="OE_N_C,DATA_W,DATA_E,SCLK_C,RCLK_C,VLOGIC_C,SDA_C,SCL_C" \
  node quadroute.mjs $B.kicad_pcb $B.q3.dsn > /dev/null || exit 1
# Lanes hop through gutter vias by design: they only ever complete at CHEAP
# via costs (measured on the single cell: 10/10 at vc=1, most incomplete at
# vc=20). Override for this stage alone.
FREEROUTING__ROUTER__SCORING__VIA_COSTS=2 \
timeout 21600 $FR -de $B.q3.dsn -do $B.q3.ses -mp 120 | grep "session completed" | sed 's/.*final/final/;s/, using.*//'
[ -s $B.q3.ses ] || { echo "stage3 NO SESSION"; exit 1; }
node checkses.mjs $B.q3.pins.json $B.q3.ses --quiet | tail -2

echo "== single-quad merge + DRC gate"
ALIAS=$(python3 -c "
cq=$CQ
base='VBUS_C=VBUS,GND_C=GND,VLOGIC_C=VLOGIC,SCLK_C=SCLK,RCLK_C=RCLK,OE_N_C=OE_N,SDA_C=SDA,SCL_C=SCL'
print(base + f',DATA_W=DATA_{cq},DATA_E=DATA_{cq+1}')")
python3 - <<PYEOF
import re
first = open('$B.q1.ses').read()
head = first[:first.index('(network_out')]
blocks = []
for f in ['$B.q1.ses', '$B.q2.ses', '$B.q3.ses']:
    t = open(f).read()
    routes = t[t.index('(network_out'):]
    blocks += re.findall(r'\(net "?[^\s)]+"?[\s\S]*?\n      \)', routes)
open('$B.union.ses', 'w').write(head + '(network_out\n' + '\n'.join(blocks) + '\n      )\n    )\n)\n')
print(len(blocks), 'net blocks unioned')
PYEOF
NET_ALIAS="$ALIAS" node mkses.mjs $B.kicad_pcb $B.union.ses $B.merged.kicad_pcb | head -2
cp $B.kicad_dru $B.merged.kicad_dru; cp $B.kicad_pro $B.merged.kicad_pro
kicad-cli pcb drc --format json --severity-error -o $B.merged.drc.json $B.merged.kicad_pcb 2>&1 | tail -1
python3 -c "
import json
from collections import Counter
d=json.load(open('$B.merged.drc.json'))
c=Counter(v['type'] for v in d.get('violations',[]) if v['severity']=='error')
print('SINGLE-QUAD DRC ERRORS:', dict(c) or 'NONE')"

echo "== clone to 42 quads"
node quadclone.mjs $B "$B.q1.ses,$B.q2.ses,$B.q3.ses"
cp $B.kicad_dru $B.full.kicad_dru; cp $B.kicad_pro $B.full.kicad_pro
kicad-cli pcb drc --format json --severity-error --severity-warning -o $B.full.drc.json $B.full.kicad_pcb 2>&1 | tail -2
python3 -c "
import json
from collections import Counter
d=json.load(open('$B.full.drc.json'))
err=Counter(v['type'] for v in d.get('violations',[]) if v['severity']=='error')
print('FULL-BOARD DRC ERRORS:', dict(err) or 'NONE')"

echo "== render"
ELEC=$(python3 eleclayers.py $B.full.kicad_pcb)
kicad-cli pcb export svg --page-size-mode 2 --exclude-drawing-sheet \
  --layers "$ELEC,B.SilkS,Edge.Cuts" -o $B.full-electronics.svg $B.full.kicad_pcb > /dev/null 2>&1
magick -density 300 -background white $B.full-electronics.svg -resize 3000x $B.full-electronics.png 2>/dev/null
echo "== quadnight done $(date)"
