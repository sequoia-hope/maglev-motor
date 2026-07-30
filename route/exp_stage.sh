#!/usr/bin/env bash
# Staged experiment: route the global buses FIRST on an empty board, merge,
# then route the full netlist carrying the bus copper forward.
#   ./exp_stage.sh <name> <tile.kicad_pcb> [buspasses] [fullpasses]
set -eu
NAME="$1"; TILE="$2"; BP="${3:-20}"; FP="${4:-30}"
export FREEROUTING__ROUTER__SCORING__VIA_COSTS="${FREEROUTING__ROUTER__SCORING__VIA_COSTS:-10}"
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS="${FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS:-1000}"
BUSES="GND,VBUS,VLOGIC,SCLK,RCLK,OE_N,SYNC,SCL,SDA,DATA"

ONLY="$BUSES" SPARE=2 LAYERS=14 DSN_OUT="$NAME.bus.dsn" node route.mjs amzhex "$TILE" --tile=3 > "$NAME.bus.route.log" 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar \
  -de "$NAME.bus.dsn" -do "$NAME.bus.ses" -mp "$BP" -mt 8 > "$NAME.bus.router.log" 2>&1 || true
[ -s "$NAME.bus.ses" ] || { echo "$NAME: bus stage produced no session"; exit 1; }
node mkses.mjs "$TILE" "$NAME.bus.ses" "$NAME.bus.kicad_pcb" > "$NAME.bus.merge.log" 2>&1

CARRY="$NAME.bus.kicad_pcb" SPARE=2 LAYERS=14 DSN_OUT="$NAME.dsn" node route.mjs amzhex "$TILE" --tile=3 > "$NAME.route.log" 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar \
  -de "$NAME.dsn" -do "$NAME.ses" -mp "$FP" -mt 8 > "$NAME.router.log" 2>&1 || true
[ -s "$NAME.ses" ] || { echo "$NAME: full stage produced no session"; exit 1; }
node mkses.mjs "$TILE" "$NAME.ses" "$NAME.kicad_pcb" > "$NAME.merge.log" 2>&1
left=$(python3 - "$NAME.kicad_pcb" <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1])
cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print(cn.GetUnconnectedCount(True))
PY
)
echo "$NAME: unconnected=$left"
