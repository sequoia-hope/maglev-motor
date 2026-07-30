#!/usr/bin/env bash
# Restrict part rotations to 0/90 and re-run the baseline experiment.
set -eu
sed -i 's|^const ROTS = .*|const ROTS = [0, Math.PI / 2];|' ../src/kicad.js
trap 'cd "$(dirname "$0")" && git -C .. checkout -- src/kicad.js' EXIT
SPARE=2 LAYERS=14 TILE_OUT=./exp_rots.kicad_pcb node gentile.mjs amzhex 3 > exp_rots.gen.log 2>&1
grep -E "Fallback|fallback|Moved|bridgesMoved|Colliding" exp_rots.gen.log | head -8 || true
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=10
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000
SPARE=2 LAYERS=14 DSN_OUT=exp_rots.dsn node route.mjs amzhex exp_rots.kicad_pcb --tile=3 > exp_rots.route.log 2>&1
timeout 3600 java -Xmx8g -jar freerouting-2.2.4.jar -de exp_rots.dsn -do exp_rots.ses -mp 30 -mt 8 > exp_rots.router.log 2>&1 || true
node mkses.mjs exp_rots.kicad_pcb exp_rots.ses exp_rots.out.kicad_pcb > exp_rots.merge.log 2>&1
python3 - exp_rots.out.kicad_pcb <<'PY'
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); cn = b.GetConnectivity(); cn.RecalculateRatsnest()
print('exp_rots (0/90 only): unconnected=', cn.GetUnconnectedCount(True))
PY
