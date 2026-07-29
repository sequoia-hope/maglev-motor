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

# The board the route was merged INTO is published beside it, so the pair in
# out/ is always the same board with and without routing and a diff between
# them is the routing and nothing else. It used to be copied here by hand,
# which is how out/amzhex-unrouted.kicad_pcb came to be two commits stale --
# it still had the footprints from before every part got an LCSC code.
if [ "$NAME" != "${NAME%-routed}" ]; then
  BARE="${NAME%-routed}-unrouted"
  cp "$BOARD" "$OUT/$BARE.kicad_pcb"
  echo "   published $BOARD as $OUT/$BARE.kicad_pcb"
else
  BARE=""
fi

# The rule files are written for the board they sit beside -- thickness
# included, because the via rules are aspect-ratio limits and a 12-layer rule
# file passes holes a 14-layer board cannot have (see fabRuleFiles).
for N in "$NAME" $BARE; do
  node -e "
import('../src/kicad.js').then(async (K) => {
  const { writeFileSync, readFileSync } = await import('fs');
  const { viaForBoard } = await import('./mkses.mjs');
  const fit = viaForBoard(readFileSync('$OUT/$N.kicad_pcb', 'utf8'));
  const r = K.fabRuleFiles({ trackWidth: 0.103, boardThickness: fit.thickness });
  writeFileSync('$OUT/$N.kicad_dru', r.dru);
  writeFileSync('$OUT/$N.kicad_pro', r.pro);
});" || exit 1
done

echo "== DRC (JLCPCB rules, for this board's own stackup)"
# NOT --severity-all: that reports items the project marks "ignore" too, which
# here means the "footprint library not configured" note about this machine's
# KiCad setup rather than anything about the board.
# The companion is checked too: it is published as a board, so it is held to
# the same standard as one, and its own summary is what says the coil copper
# was already clean before any routing landed on it.
for N in "$NAME" $BARE; do
  kicad-cli pcb drc --format json --severity-error --severity-warning \
    -o "$OUT/$N.drc.json" "$OUT/$N.kicad_pcb" 2>&1 | tail -3
done

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
if [ -n "$BARE" ]; then
  echo
  echo "== summary ($BARE)"
  python3 summarise.py "$OUT/$BARE.drc.json" "$OUT/$BARE.kicad_pcb" | tee "$OUT/$BARE.summary.txt"
fi
echo
echo "results in $(pwd)/$OUT/"
ls -la "$OUT/"
