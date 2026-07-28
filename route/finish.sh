#!/usr/bin/env bash
# Merge a freerouting .ses into the full board, DRC it against the JLCPCB rules,
# and render what came out -- whether or not the route completed. Everything
# lands in route/out/ so the result is viewable either way.
#
#   ./finish.sh <board.kicad_pcb> <routed.ses> <name>
set -u
BOARD="${1:-amzhex.kicad_pcb}"
SES="${2:-amzhex.route.ses}"
NAME="${3:-amzhex-routed}"
OUT=out
mkdir -p "$OUT"

echo "== merging $SES into $BOARD"
MERGE=$(node mkses.mjs "$BOARD" "$SES" "$OUT/$NAME.kicad_pcb") || exit 1
echo "$MERGE"
# Held for the summary below, not just printed: a net the router shorted is
# routing the board does not have, and the summary beside the board is the
# tracked artefact. Without it that file reads "563 unrouted" and says nothing
# about why two of them are missing.
DROPPED=$(echo "$MERGE" | grep '^DROPPED ' || true)
# The rule files are written for the board that was just merged -- thickness
# included, because the via rules are aspect-ratio limits and a 12-layer rule
# file passes holes a 14-layer board cannot have (see fabRuleFiles).
node -e "
import('../src/kicad.js').then(async (K) => {
  const { writeFileSync, readFileSync } = await import('fs');
  const { viaForBoard } = await import('./mkses.mjs');
  const fit = viaForBoard(readFileSync('$OUT/$NAME.kicad_pcb', 'utf8'));
  const r = K.fabRuleFiles({ trackWidth: 0.103, boardThickness: fit.thickness });
  writeFileSync('$OUT/$NAME.kicad_dru', r.dru);
  writeFileSync('$OUT/$NAME.kicad_pro', r.pro);
});" || exit 1

echo "== DRC (JLCPCB rules, for this board's own stackup)"
# NOT --severity-all: that reports items the project marks "ignore" too, which
# here means the "footprint library not configured" note about this machine's
# KiCad setup rather than anything about the board.
kicad-cli pcb drc --format json --severity-error --severity-warning \
  -o "$OUT/$NAME.drc.json" "$OUT/$NAME.kicad_pcb" 2>&1 | tail -3

echo "== rendering"
# Electronics side: the routed copper plus the parts. Which layers those are
# depends on the stackup, so read them off the board (see eleclayers.py).
ELEC=$(python3 eleclayers.py "$OUT/$NAME.kicad_pcb")
echo "   electronics layers: $ELEC"
kicad-cli pcb export svg --page-size-mode 2 --exclude-drawing-sheet \
  --layers "$ELEC,B.SilkS,Edge.Cuts" -o "$OUT/$NAME-electronics.svg" \
  "$OUT/$NAME.kicad_pcb" >/dev/null 2>&1
# One winding layer, for scale and sanity.
kicad-cli pcb export svg --page-size-mode 2 --exclude-drawing-sheet \
  --layers "F.Cu,Edge.Cuts" -o "$OUT/$NAME-coils.svg" \
  "$OUT/$NAME.kicad_pcb" >/dev/null 2>&1
for f in "$OUT/$NAME-electronics" "$OUT/$NAME-coils"; do
  [ -f "$f.svg" ] && magick -density 300 -background white "$f.svg" -resize 2400x "$f.png"
done

echo "== summary"
{
  python3 summarise.py "$OUT/$NAME.drc.json" "$OUT/$NAME.kicad_pcb"
  [ -n "$DROPPED" ] && printf '\n%s\n' "$DROPPED"
} | tee "$OUT/$NAME.summary.txt"
echo
echo "results in $(pwd)/$OUT/"
ls -la "$OUT/"
