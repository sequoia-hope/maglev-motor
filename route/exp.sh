#!/usr/bin/env bash
# One tile routing experiment: DSN -> freerouting -> merge -> count unconnected.
#   ./exp.sh <name> <tile.kicad_pcb> [passes]
# Extra freerouting env goes through the caller's environment (FREEROUTING__*).
set -eu
NAME="$1"; TILE="$2"; PASSES="${3:-30}"
export FREEROUTING__ROUTER__SCORING__VIA_COSTS="${FREEROUTING__ROUTER__SCORING__VIA_COSTS:-10}"
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS="${FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS:-1000}"

SPARE=2 LAYERS=14 DSN_OUT="$NAME.dsn" node route.mjs amzhex "$TILE" --tile=3 > "$NAME.route.log" 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar \
  -de "$NAME.dsn" -do "$NAME.ses" -mp "$PASSES" -mt 8 > "$NAME.router.log" 2>&1 || true
[ -s "$NAME.ses" ] || { echo "$NAME: no session output"; exit 1; }
node mkses.mjs "$TILE" "$NAME.ses" "$NAME.kicad_pcb" > "$NAME.merge.log" 2>&1
left=$(python3 - "$NAME.kicad_pcb" <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1])
cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print(cn.GetUnconnectedCount(True))
PY
)
vias=$(grep -c "(via " "$NAME.kicad_pcb" || true)
echo "$NAME: unconnected=$left vias=$vias"
