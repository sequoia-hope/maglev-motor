#!/bin/bash
# Staged quad routing: grouped stages, each carried forward PROTECTED, each
# verified geometrically. Groups keep the carried-fragment volume low (the
# net-by-net version hit freerouting's carried-wiring hang at ~10 stages).
#   ./quadstage.sh [boardKey]
set -e
cd "$(dirname "$0")"
B="${1:-quadexp}"
VC="${VC:-20}" RC="${RC:-100}" PASSES="${PASSES:-100}"
LOCALS=$(python3 -c "
import json
s=json.load(open('$B.quads.json'))
c=s['quads'][s['centreQuad']]['cells']
print(','.join(f'coil_{i}_A,coil_{i}_B,PWMA_{i},PWMB_{i}' for i in c))")
S2="GND_C,VBUS_C"
S3="OE_N_C,DATA_W,DATA_E,SCLK_C,RCLK_C,VLOGIC_C,SDA_C,SCL_C"
PREV=""
STEP=0
ACC=""
for GROUP in "$LOCALS" "$S2" "$S3"; do
  STEP=$((STEP+1))
  ACC="${ACC:+$ACC,}$GROUP"
  DSN="$B.q$STEP.dsn"; SES="$B.q$STEP.ses"
  RESTRICT="$ACC" SES_CARRY="$PREV" node quadroute.mjs "$B.kicad_pcb" "$DSN" > /dev/null 2>&1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=$VC FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=$RC \
  timeout 600 java -Xss512m -Xmx8g -jar freerouting-2.2.4.jar -de "$DSN" -do "$SES" -mp "$PASSES" > "$B.q$STEP.log" 2>&1 || true
  if [ ! -s "$SES" ]; then echo "stage $STEP: NO SESSION (hang/timeout?)"; exit 1; fi
  echo "stage $STEP: $(grep -o 'final score.*' "$B.q$STEP.log" | tail -1 | sed 's/, using.*//')"
  PREV="$SES"
done
cp "$PREV" "$B.staged.ses"
echo "== geometric verdict"
node checkses.mjs "$B.q3.pins.json" "$B.staged.ses" --quiet | tail -6
