#!/usr/bin/env bash
# Variant A: bus stage with cheap vias and more passes, then full.
set -eu
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
BUSES="GND,VBUS,VLOGIC,SCLK,RCLK,OE_N,SYNC,SCL"
FREEROUTING__ROUTER__SCORING__VIA_COSTS=1 ONLY="$BUSES" SPARE=2 LAYERS=14 DSN_OUT=stA2.bus.dsn node route.mjs amzhex tile_clean.kicad_pcb --tile=3 > stA2.bus.route.log 2>&1
FREEROUTING__ROUTER__SCORING__VIA_COSTS=1 timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de stA2.bus.dsn -do stA2.bus.ses -mp 40 -mt 6 > stA2.bus.router.log 2>&1 || true
node mkses.mjs tile_clean.kicad_pcb stA2.bus.ses stA2.bus.kicad_pcb > stA2.bus.merge.log 2>&1
CARRY=stA2.bus.kicad_pcb SPARE=2 LAYERS=14 DSN_OUT=stA2.dsn node route.mjs amzhex tile_clean.kicad_pcb --tile=3 > stA2.route.log 2>&1
FREEROUTING__ROUTER__SCORING__VIA_COSTS=10 timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de stA2.dsn -do stA2.ses -mp 30 -mt 6 > stA2.router.log 2>&1 || true
node mkses.mjs tile_clean.kicad_pcb stA2.ses stA2.kicad_pcb > stA2.merge.log 2>&1
python3 - stA2.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('stA2 (cheap-via bus stage): unconnected=', cn.GetUnconnectedCount(True))
PY
grep -oE "session completed.*" stA2.bus.router.log | tail -1
