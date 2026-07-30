#!/usr/bin/env bash
# Variant B: LOCALS first (coil hookups, PWM, DATA links), then everything.
set -eu
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=10
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
LOCALS=$(node -e "
const fs=require('fs');
const d=fs.readFileSync('exp_base.dsn','utf8');
const nets=[...d.matchAll(/^    \(net ([^\s)]+)/gm)].map(m=>m[1].replace(/\"/g,''));
console.log(nets.filter(n=>/^coil_|^PWM|^DATA_|^DEADMAN/.test(n)).join(','));
")
ONLY="$LOCALS" SPARE=2 LAYERS=14 DSN_OUT=exp_stB.loc.dsn node route.mjs amzhex exp_base.kicad_pcb --tile=3 > exp_stB.loc.route.log 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de exp_stB.loc.dsn -do exp_stB.loc.ses -mp 30 -mt 6 > exp_stB.loc.router.log 2>&1 || true
node mkses.mjs exp_base.kicad_pcb exp_stB.loc.ses exp_stB.loc.kicad_pcb > exp_stB.loc.merge.log 2>&1
CARRY=exp_stB.loc.kicad_pcb SPARE=2 LAYERS=14 DSN_OUT=exp_stB.dsn node route.mjs amzhex exp_base.kicad_pcb --tile=3 > exp_stB.route.log 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de exp_stB.dsn -do exp_stB.ses -mp 30 -mt 6 > exp_stB.router.log 2>&1 || true
node mkses.mjs exp_base.kicad_pcb exp_stB.ses exp_stB.kicad_pcb > exp_stB.merge.log 2>&1
python3 - exp_stB.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('exp_stB (locals-first): unconnected=', cn.GetUnconnectedCount(True))
PY
grep -oE "session completed.*" exp_stB.loc.router.log | tail -1
