#!/bin/bash
# The HYBRID full-board pipeline: tile what tiles, route the rest in place.
#
#   stamp2.mjs    the 2x2 quad as a TORUS, every net negotiated at once on all
#                 14 layers (gridrouter.mjs) -- 24 nets + 16 in-stamp bus links
#   service.mjs   header + dead-man back on the bare board, before routing
#   assemble.mjs  pattern the stamp on every quad where it is legal and
#                 anchored; patch-route each rim quad's own needs in a window
#                 of the real board; then the board-level nets
#   pour.py       VBUS/GND rails poured into the gutters on all 14 layers, cut
#                 into a tree so no coil is encircled; fed by the barrels
#                 service.mjs puts at the header's power pins
#   fullgate.sh   whole-board DRC (no rim exemption), coilcheck, true ratsnest
#   coilleads.py  every bridge output on its own coil terminal, nothing else
#   ringcheck.py  no coil is ringed by poured copper (a shorted turn)
#   powercheck.py the power copper solved as a resistor network: supply-loop
#                 resistance per bridge, rail drop, worst current density
#
#   ./full.sh              env: BASE=<bare board key, default fabtile2>
#                               OUT_KEY=<output key, default amzfull>
#                               SKIP_STAMP=1 reuse $OUT_KEY.paths.json
#                               FEED_VIAS barrels per header power pin (service.mjs;
#                               default 0 -- see there for why)
#
# BASE is a quadgen board (qlane.sh / fabtile2) and BASE.union.ses supplies the
# straight In12 lane runs and power trunks, which stay fixed copper.
set -u
cd "$(dirname "$0")"
B=${BASE:-fabtile2}; K=${OUT_KEY:-amzfull}
exec > >(tee "$K.log") 2>&1
echo "== $K start $(date)"

if [ -z "${SKIP_STAMP:-}" ]; then
  echo "== stamp: torus negotiation (MESH=2: all eight bus nets linked north-south)"
  MESH=2 ITERS=${ITERS_STAMP:-300} DUMP=$K.paths.json node stamp2.mjs $B $K.stamp.ses | grep -v '^iter' || { echo "STAMP DID NOT CONVERGE"; exit 1; }
  echo "== stamp gates (single quad on the bare board + its 8 periodic images)"
  BASE=$B ./t2gate.sh $K.stamp $K.stamp.ses
fi

echo "== service parts (the board has exactly four spots that hold a 2x5 header at"
echo "   >= 0.2 mm from every barrel, each route-tested: one walls PWMA_10 in, and the"
echo "   interior one leaves the header's DATA pins no path to their lanes even with"
echo "   its quad routed from scratch. This east-rim spot routes.)"
JSPINE_AT=${JSPINE_AT:-105.333,96.188,90} MINCLR=0.2 node service.mjs $B $K.bare || exit 1
VALIDATE_SKIP=1 node coilcheck.mjs $K.bare.kicad_pcb | tail -1

echo "== assemble: pattern + patch + board nets"
node --max-old-space-size=48000 assemble.mjs $K.bare $K.paths.json $K || exit 1

echo "== power rails: VBUS and GND poured into the gutters, as a tree (no coil encircled)"
cp $B.kicad_dru $K.kicad_dru; cp $B.kicad_pro $K.kicad_pro
cp $K.kicad_pcb $K.routed.kicad_pcb                 # the routed board before the pour: powercheck's "before"
BASE=$B python3 pour.py $K.routed.kicad_pcb $K.kicad_pcb || exit 1

echo "== whole-board gates"
BASE=$B ./fullgate.sh $K
[ -e $B.terminals.json ] || node termdump.mjs $B $B.terminals.json
python3 coilleads.py $K.bare.kicad_pcb $K.kicad_pcb $B.terminals.json
python3 openlist.py $K.kicad_pcb
BASE=$B python3 ringcheck.py $K.kicad_pcb
echo "-- power copper before the pour (tracks only)"
python3 powercheck.py $K.routed.kicad_pcb $K.power-before.json | tail -2
echo "-- power copper as built"
# the gate: no power conductor works harder at hover than the windings do (70 A/mm2),
# and no bridge sees more than 2% of its 10 ohm coil in its supply loop
LIMIT_J=${LIMIT_J:-70} LIMIT_LOOP=${LIMIT_LOOP:-200} MAP=$K.power python3 powercheck.py $K.kicad_pcb $K.power.json
echo "== $K done $(date)"
