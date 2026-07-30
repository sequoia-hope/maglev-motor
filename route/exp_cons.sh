#!/usr/bin/env bash
set -eu
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=10
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
CARRY=tile_bus.kicad_pcb PROTECT_CARRY=1 SPARE=2 LAYERS=14 DSN_OUT=cons.dsn node route.mjs amzhex tile_bus.kicad_pcb --tile=3 > cons.route.log 2>&1
timeout 3600 java -Xmx8g -Xss512m -jar freerouting-2.2.4.jar -de cons.dsn -do cons.ses -mp 30 -mt 6 > cons.router.log 2>&1 || true
node mkses.mjs tile_bus.kicad_pcb cons.ses cons.kicad_pcb > cons.merge.log 2>&1
python3 - cons.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('cons (constructed buses + protected carry): unconnected=', cn.GetUnconnectedCount(True))
PY
