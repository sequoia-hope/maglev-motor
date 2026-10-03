#!/bin/bash
# The hand-routing loop for the periodic stamp. freerouting is done (it scores
# 0.00 on every residue net) and the A* has proofs of death for the rest at
# this register placement -- what remains is eyes and a mouse, so this script
# packages the machine's half of the deal:
#
#   ./hand.sh build [ses]   make hand.kicad_pcb: the bare board + the stamp's
#                           routed copper (UNLOCKED -- yours) + the 8
#                           neighbouring stamp images (LOCKED reference copper,
#                           correct alias nets, so pcbnew's live DRC shows the
#                           periodic walls). Default ses: $KEY.union.ses.
#   ./hand.sh check         extract your copper -> hand.union.ses, then run
#                           every gate: tilecheck (stamp vs its own images),
#                           mkses merge, coilcheck, DRC, 42x clone + interior
#                           DRC, true ratsnest. QUICK=1 skips the clone+DRC.
#   ./hand.sh rebuild       extract, then rebuild the board from YOUR copper --
#                           refreshes the images so your new tracks' own
#                           periodic images become visible walls too. Do this
#                           after every good check.
#
# Rules of the game (also in report/hand.html):
#   * never unlock or move locked copper -- windings, tabs, coil/seam vias and
#     parts exist per-cell and only the GENERATOR may move them; images are
#     tilecheck's ground truth;
#   * route only on the stamp's own nets (handses refuses anything else);
#   * a clean pcbnew DRC is NECESSARY, not sufficient: your copper's own
#     periodic image only exists after a rebuild, and same-net winding
#     crossings are DRC-invisible -- tilecheck and coilcheck are the real
#     referees, so run check often.
set -u
cd "$(dirname "$0")"
KEY=${KEY:-fabtile2}
CQ=$(python3 -c "import json; print(json.load(open('$KEY.quads.json'))['centreQuad'])")
ALIAS="VBUS_C=VBUS,GND_C=GND,VLOGIC_C=VLOGIC,VLOGIC_CW=VLOGIC,VLOGIC_CE=VLOGIC,SCLK_C=SCLK,RCLK_C=RCLK,OE_N_C=OE_N,SDA_C=SDA,SCL_C=SCL,DATA_W=DATA_$CQ,DATA_E=DATA_$((CQ+1))"

build () {
  local SES="${1:-$KEY.union.ses}"
  if [ -e hand.kicad_pcb ] && [ -z "${FORCE:-}" ]; then
    echo "hand.kicad_pcb exists. './hand.sh rebuild' keeps your copper;"
    echo "FORCE=1 ./hand.sh build discards it."; exit 1
  fi
  echo "== hand board from $SES"
  NET_ALIAS="$ALIAS" node mkses.mjs $KEY.kicad_pcb "$SES" hand.tmp.kicad_pcb || exit 1
  node handimages.mjs $KEY "$SES" hand.tmp.kicad_pcb || exit 1
  python3 handlock.py hand.tmp.kicad_pcb "$SES" hand.kicad_pcb || exit 1
  rm -f hand.tmp.kicad_pcb
  cp $KEY.kicad_dru hand.kicad_dru
  python3 - <<'PY'   # project file: light the missing nets
import json
d = json.load(open('fabtile2.merged.kicad_pro'))
ns = d.setdefault('net_settings', {'classes': [], 'meta': {'version': 4}})
ns['net_colors'] = {
    'PWMA_78': 'rgb(255, 45, 149)',
    'PWMA_79': 'rgb(255, 159, 26)',
    'PWMB_79': 'rgb(255, 232, 26)',
    'PWMB_90': 'rgb(39, 232, 167)',
    'PWMA_91': 'rgb(41, 182, 255)',
    'VLOGIC':  'rgb(199, 125, 255)',
}
json.dump(d, open('hand.kicad_pro', 'w'), indent=2)
print('hand.kicad_pro: net colours set for the 6 missing nets')
PY
  [ -e hand.kicad_prl ] || cp out/amzhex-stamp.kicad_prl hand.kicad_prl 2>/dev/null || true
  echo "OPEN:  kicad hand.kicad_pro    (save in pcbnew, then ./hand.sh check)"
}

check () {
  [ -e hand.kicad_pcb ] || { echo "no hand.kicad_pcb -- ./hand.sh build first"; exit 1; }
  local FAIL=0

  echo "== extract (unlocked copper -> hand.union.ses)"
  python3 handses.py hand.kicad_pcb hand.union.ses $KEY.quads.json || FAIL=1

  echo "== tiling gate: the stamp against its 8 periodic images"
  node tilecheck.mjs $KEY hand.union.ses | tail -n +2
  if [ "${PIPESTATUS[0]}" = 0 ]; then echo "   TILES: CLEAN"
  else echo "   TILES: CONFLICTS (see above)"; FAIL=1; fi

  echo "== merge onto the bare board"
  NET_ALIAS="$ALIAS" node mkses.mjs $KEY.kicad_pcb hand.union.ses hand.merged.kicad_pcb || exit 1
  cp $KEY.kicad_dru hand.merged.kicad_dru
  cp $KEY.merged.kicad_pro hand.merged.kicad_pro 2>/dev/null || cp $KEY.kicad_pro hand.merged.kicad_pro

  echo "== coilcheck (same-net winding/tab/via shorts no DRC can see)"
  node coilcheck.mjs hand.merged.kicad_pcb || { echo "   COILCHECK FAILED"; FAIL=1; }

  echo "== DRC (merged stamp board)"
  kicad-cli pcb drc --format json --severity-error -o hand.merged.drc.json hand.merged.kicad_pcb >/dev/null 2>&1
  python3 - <<'PY' || FAIL=1
import json, sys
from collections import Counter
d = json.load(open('hand.merged.drc.json'))
c = Counter(v['type'] for v in d.get('violations', []) if v['severity'] == 'error')
print('   DRC errors:', dict(c) or 'NONE')
sys.exit(1 if c else 0)
PY

  if [ -z "${QUICK:-}" ]; then
    echo "== clone 42x + full-board DRC (interior must stay clean)"
    cp $KEY.quads.json handfull.quads.json
    cp -p $KEY.kicad_pcb handfull.kicad_pcb        # -p: the coilcheck stamp pins mtime
    cp $KEY.kicad_pcb.coilcheck.json handfull.kicad_pcb.coilcheck.json
    node quadclone.mjs handfull hand.union.ses | tail -2
    cp $KEY.kicad_dru handfull.full.kicad_dru; cp $KEY.kicad_pro handfull.full.kicad_pro
    kicad-cli pcb drc --format json --severity-error -o handfull.full.drc.json handfull.full.kicad_pcb >/dev/null 2>&1
    python3 - <<'PY' || FAIL=1
import json, sys
d = json.load(open('handfull.full.drc.json'))
t = open('handfull.full.kicad_pcb').read()
import re
xs, ys = [], []
for m in re.finditer(r'\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\)[^)]*\(layer "Edge.Cuts"\)', t):
    xs += [float(m.group(1)), float(m.group(3))]; ys += [float(m.group(2)), float(m.group(4))]
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
RIM = 6.0            # quadclone's outline trims live at the board edge; the
                     # reference clone's junk reaches 5.06 mm in, never deeper
inner, rim = [], 0
for v in d.get('violations', []):
    if v['severity'] != 'error': continue
    p = v['items'][0]['pos']
    if x0 + RIM < p['x'] < x1 - RIM and y0 + RIM < p['y'] < y1 - RIM:
        inner.append(v)
    else:
        rim += 1
print(f'   full board: {rim} rim violations (spine territory, expected), {len(inner)} INTERIOR')
for v in inner[:8]:
    p = v['items'][0]['pos']
    print(f"     {v['type']} at {p['x']:.2f},{p['y']:.2f}: {v['description'][:70]}")
sys.exit(1 if inner else 0)
PY
    echo "== true ratsnest (pcbnew connectivity; the DRC report caps at ~500)"
    cp $KEY.quads.json hand.quads.json     # airwires derives <board>.quads.json
    python3 airwires.py hand.merged.kicad_pcb 59.0 53.0 84.0 73.0 \
        report/quad-allcu.png report/hand-airwires.png | tail -3
    python3 - <<'PY'
import json
d = json.load(open('report/hand-airwires.json'))
base = {'PWMA_78', 'PWMA_79', 'PWMA_91', 'PWMB_79', 'PWMB_90', 'VLOGIC'}
now = {n['net'] for n in d['nets']}
print(f"   tile airwires: {d['tile_airwires']} (started from 6)")
for n in sorted(base - now): print(f'     CLOSED  {n}')
for n in sorted(now & base): print(f'     open    {n}')
for n in sorted(now - base): print(f'     NEW MISS {n}  <- this was connected before')
PY
  fi

  echo
  if [ "$FAIL" = 0 ]; then
    echo "== ALL GATES GREEN. ./hand.sh rebuild refreshes the images around your new copper."
  else
    echo "== GATES FAILED (see above). The board is untouched; fix in pcbnew and re-check."
  fi
  return $FAIL
}

case "${1:-}" in
  build)   build "${2:-}";;
  check)   check;;
  rebuild) python3 handses.py hand.kicad_pcb hand.union.ses $KEY.quads.json || exit 1
           FORCE=1; build hand.union.ses;;
  *) sed -n '2,29p' "$0"; exit 1;;
esac
