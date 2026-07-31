#!/bin/bash
# One SR-placement candidate through the reduced qlane pipeline (SR rotation
# co-design; see srscan.mjs). Reduced = SR_SWEEP lanegen (no SR-relative
# constructions), R1+R2 only, no union/merge/DRC -- this ranks candidates by
# checkses miss count; the winner gets the full qlane.sh treatment after.
#   ./srsweep-one.sh KEY RX RY ROT     (results line appended to srsweep.results.log)
set -u
cd "$(dirname "$0")"
KEY=$1; RX=$2; RY=$3; ROT=$4
FR="java -Xss1024m -Xmx8g -jar freerouting-2.2.4.jar"
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=20 FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=100
say () { echo "[$KEY $RX,$RY,$ROT] $*"; }
dead () { echo -e "$KEY\t$RX\t$RY\t$ROT\tDEAD\t$1" >> srsweep.results.log; say "DEAD: $1"; exit 0; }

U_AT="1.493,2.396,180" C_AT="2.093,0.596,0" SR_AT="$RX,$RY,$ROT" \
  OUT_KEY=$KEY node quadgen.mjs amzhex > $KEY.gen.log 2>&1 || dead "quadgen: $(tail -1 $KEY.gen.log)"
# the winding is byte-identical for every candidate (only parts moved); the
# committed board passed coilcheck today, so sweep stages skip the stamp gate
VALIDATE_SKIP=1 SR_SWEEP=1 SR_CONSTRUCT="${SR_CONSTRUCT:-}" node lanegen.mjs $KEY.kicad_pcb $KEY.lanes.ses > $KEY.lanegen.log 2>&1 \
  || dead "lanegen: $(grep -m1 VIOLATION $KEY.lanegen.log || tail -1 $KEY.lanegen.log)"
CONS=$(grep -m1 '^constructed paths:' $KEY.lanegen.log | cut -d: -f2)
SRS=$(python3 -c "import json; print(','.join(json.load(open('$KEY.lanes.srstub.json'))))")

TODO=$(python3 -c "import json; print(','.join(json.load(open('$KEY.lanes.todo.json'))))")
DONE="VLOGIC_C,SDA_C,SCL_C,SCLK_C,RCLK_C,OE_N_C,DATA_W,DATA_E,GND_C,VBUS_C"
COILS_TODO=$(echo "$TODO" | tr ',' '\n' | grep '^coil' | paste -sd, -)
REST_TODO=$(echo "$TODO" | tr ',' '\n' | grep -v '^coil' | paste -sd, -)

run_stage () {  # $1 name  $2 restrict  $3 carry list  $4 mp
  VALIDATE_SKIP=1 DONE_NETS="$DONE" TAPS=$KEY.lanes.taps.json CARRY_AS_KEEPOUT=1 \
  SES_CARRY="$3" RESTRICT="$2" SR_STUBBED="$SRS" \
    node quadroute.mjs $KEY.kicad_pcb $KEY.$1.dsn > $KEY.$1.gen.log 2>&1 || return 1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=5 \
  timeout 1200 $FR -de $KEY.$1.dsn -do $KEY.$1.ses -mp $4 > $KEY.$1.router.log 2>&1
  [ -s $KEY.$1.ses ] || return 1
}
fails () {
  node checkses.mjs $KEY.$1.pins.json $KEY.$1.ses 2>/dev/null | grep "SPLIT" | cut -d: -f1 \
    | grep -xF -f <(echo "$2" | tr ',' '\n') | paste -sd, -
}

say "R1 coils [$COILS_TODO]"
run_stage r1 "$COILS_TODO" "$KEY.lanes.ses" 60 || dead "stage r1 failed"
F1=$(fails r1 "$COILS_TODO")
say "R2 pocket [$REST_TODO]"
run_stage r2 "$REST_TODO" "$KEY.lanes.ses,$KEY.r1.ses" 150 || dead "stage r2 failed"
F2=$(fails r2 "$REST_TODO")

MISS=$(echo "$F1,$F2" | tr ',' '\n' | grep -v '^$' | sort -u | paste -sd, -)
N=$(echo "$MISS" | tr ',' '\n' | grep -vc '^$')
echo -e "$KEY\t$RX\t$RY\t$ROT\t$N\t$MISS\tcons:$CONS" >> srsweep.results.log
say "misses $N: $MISS"
