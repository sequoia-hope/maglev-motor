#!/usr/bin/env bash
# Two-stage with the stage-1 bus copper PROTECTED in stage 2.
set -eu
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
BUSES="GND,VBUS,VLOGIC,SCLK,RCLK,OE_N,SYNC,SCL"
FREEROUTING__ROUTER__SCORING__VIA_COSTS=1 ONLY="$BUSES" SPARE=2 LAYERS=14 DSN_OUT=prot.bus.dsn node route.mjs amzhex tile_clean.kicad_pcb --tile=3 > prot.bus.route.log 2>&1
FREEROUTING__ROUTER__SCORING__VIA_COSTS=1 timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de prot.bus.dsn -do prot.bus.ses -mp 40 -mt 6 > prot.bus.router.log 2>&1 || true
node mkses.mjs tile_clean.kicad_pcb prot.bus.ses prot.bus.kicad_pcb > prot.bus.merge.log 2>&1
CARRY=prot.bus.kicad_pcb PROTECT_CARRY=1 SPARE=2 LAYERS=14 DSN_OUT=prot.dsn node route.mjs amzhex prot.bus.kicad_pcb --tile=3 > prot.route.log 2>&1
FREEROUTING__ROUTER__SCORING__VIA_COSTS=10 timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de prot.dsn -do prot.ses -mp 30 -mt 6 > prot.router.log 2>&1 || true
node mkses.mjs prot.bus.kicad_pcb prot.ses prot.kicad_pcb > prot.merge.log 2>&1
python3 - prot.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('prot (router buses, protected in stage 2): unconnected=', cn.GetUnconnectedCount(True))
PY
