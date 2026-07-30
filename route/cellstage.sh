#!/bin/bash
# Net-by-net build of the single-cell routing: route one net at a time, carry
# everything already routed as PROTECTED copper (router-generated protected
# carry is the one freerouting handles), verify the final session geometrically
# with cellcheck.mjs. Order: most-constrained first.
#   ./cellstage.sh <boardKey>          (e.g. sw_d)
set -e
cd "$(dirname "$0")"
B="${1:-sw_d}"
VC="${VC:-20}" RC="${RC:-100}" PASSES="${PASSES:-40}"
CENTRE=4
ORDER="coil_${CENTRE}_B coil_${CENTRE}_A PWMA_${CENTRE} PWMB_${CENTRE} GND_C VBUS_C OE_N_C DATA_W DATA_E SCLK_C RCLK_C VLOGIC_C SDA_C SCL_C"
ACC=""
PREV=""
STEP=0
for NET in $ORDER; do
  STEP=$((STEP+1))
  ACC="${ACC:+$ACC,}$NET"
  DSN="$B.s$STEP.dsn"; SES="$B.s$STEP.ses"
  RESTRICT="$ACC" SES_CARRY="$PREV" node cellroute.mjs "$B.kicad_pcb" "$DSN" > /dev/null 2>&1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=$VC FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=$RC \
  java -Xss512m -Xmx4g -jar freerouting-2.2.4.jar -de "$DSN" -do "$SES" -mp "$PASSES" > "$B.s$STEP.log" 2>&1 || true
  if [ ! -s "$SES" ]; then echo "$STEP $NET: NO SESSION"; exit 1; fi
  echo "$STEP $NET: $(grep -o 'final score.*' "$B.s$STEP.log" | tail -1 | sed 's/, using.*//')"
  PREV="$SES"
done
echo "== final geometric check"
node cellcheck.mjs "$B.kicad_pcb" "$PREV"
cp "$PREV" "$B.staged.ses"
