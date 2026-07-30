#!/usr/bin/env bash
set -eu
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=10
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
BLIND=1 SPARE=2 LAYERS=14 DSN_OUT=blind2.dsn node route.mjs amzhex tile_clean.kicad_pcb --tile=3 > blind2.route.log 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de blind2.dsn -do blind2.ses -mp 30 -mt 8 > blind2.router.log 2>&1 || true
node mkses.mjs tile_clean.kicad_pcb blind2.ses blind2.kicad_pcb > blind2.merge.log 2>&1
python3 - blind2.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1])
cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('blind2: unconnected=', cn.GetUnconnectedCount(True))
PY
