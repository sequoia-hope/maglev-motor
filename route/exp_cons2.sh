#!/usr/bin/env bash
set -eu
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=10
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
CARRY=tile_bus.kicad_pcb SPARE=2 LAYERS=14 DSN_OUT=cons2.dsn node route.mjs amzhex tile_bus.kicad_pcb --tile=3 > cons2.route.log 2>&1
timeout 1200 java -Xmx8g -Xss512m -jar freerouting-2.2.4.jar -de cons2.dsn -do cons2.ses -mp 30 -mt 6 > cons2.router.log 2>&1 || true
[ -s cons2.ses ] || { echo "cons2: no session output"; exit 1; }
node mkses.mjs tile_bus.kicad_pcb cons2.ses cons2.kicad_pcb > cons2.merge.log 2>&1
python3 - cons2.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('cons2 (constructed buses, unprotected carry): unconnected=', cn.GetUnconnectedCount(True))
PY
