#!/bin/bash
# Net-by-net locals over the completed lanes+power session (dbgfix.lp.ses),
# cellstage-style: cumulative RESTRICT, protected SES carry, most-constrained
# first (PWM pairs per cell, then coil halves).
set -e
cd "$(dirname "$0")"
LANES="OE_N_C,DATA_W,DATA_E,SCLK_C,RCLK_C,VLOGIC_C,SDA_C,SCL_C"
ACC="$LANES,GND_C,VBUS_C"
PREV=dbgfix.lp.ses
ORDER="PWMA_78 PWMB_78 PWMA_79 PWMB_79 PWMA_90 PWMB_90 PWMA_91 PWMB_91 coil_78_A coil_78_B coil_79_A coil_79_B coil_90_A coil_90_B coil_91_A coil_91_B"
STEP=0
for NET in $ORDER; do
  STEP=$((STEP+1))
  ACC="$ACC,$NET"
  DSN="dbgfix.n$STEP.dsn"; SES="dbgfix.n$STEP.ses"
  RESTRICT="$ACC" SES_CARRY="$PREV" node quadroute.mjs quadnight.kicad_pcb "$DSN" > /dev/null 2>&1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=20 FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=100 \
  timeout 900 java -Xss512m -Xmx8g -jar freerouting-2.2.4.jar -de "$DSN" -do "$SES" -mp 30 > "dbgfix.n$STEP.log" 2>&1 || true
  if [ ! -s "$SES" ]; then echo "$STEP $NET: NO SESSION (hang/timeout)"; exit 1; fi
  echo "$STEP $NET: $(grep -o 'final score.*' "dbgfix.n$STEP.log" | tail -1 | sed 's/, using.*//')"
  PREV="$SES"
done
echo "== final geometric check"
node checkses.mjs dbgfix.n$STEP.pins.json "$PREV" --quiet
cp "$PREV" dbgfix.nbn.ses
