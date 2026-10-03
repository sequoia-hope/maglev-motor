#!/usr/bin/env bash
# Build route/report/ -- the documentation page's renders, all regenerated from
# the board file itself so the page can never drift from the copper.
#
#   ./report.sh [board.kicad_pcb]        default: fabtest.merged.kicad_pcb
#
# Two helpers do the zooming, and both exist because kicad-cli will not:
#   boardwin.py  throws away copper outside the window BEFORE plotting (the
#                full board is 300 000 spiral segments; a 24 MB SVG takes
#                minutes to rasterise and 20 MB to store);
#   svgwin.py    sets the viewBox to the window afterwards, which is what makes
#                the crop pixel-exact against board millimetres. page-size-mode
#                1 writes board mm one-to-one, so this is just a header rewrite.
# (page-size-mode 2 looks like the right tool and is not: measured, it renders
# a 106.13 mm board 103.76 mm wide with the west edge off the canvas.)
set -u
cd "$(dirname "$0")"
BOARD="${1:-fabtest.merged.kicad_pcb}"
OUT=${OUT:-report}
ONLY=${ONLY:-}          # substring filter: render only shots whose name matches
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

PAGE_W=419.9890                       # page-size-mode 1 page width, for --mirror
ELEC=$(python3 eleclayers.py "$BOARD")                      # In12.Cu,B.Cu
ALLCU=$(python3 -c "
import re
print(','.join(re.findall(r'\(\d+ \"([FB]\.Cu|In\d+\.Cu)\" signal\)', open('$BOARD').read())))")
WIND=$(python3 -c "print('$ALLCU'.split(',')[0])")          # F.Cu, one winding layer

# shot <name> <x1> <y1> <x2> <y2> <px> <layers> [mirror]
#   plot the window's own board, then cut the viewBox to it exactly.
shot () {
  local n=$1 x1=$2 y1=$3 x2=$4 y2=$5 px=$6 l=$7 m=${8:-}
  [ -n "$ONLY" ] && [[ "$n" != *"$ONLY"* ]] && return 0
  local b="$TMP/$n.kicad_pcb" s="$TMP/$n.svg" w="$TMP/$n.win.svg"
  python3 boardwin.py "$BOARD" "$b" "$x1" "$y1" "$x2" "$y2" 3 >/dev/null
  kicad-cli pcb export svg --page-size-mode 1 --exclude-drawing-sheet \
    --mode-single ${m:+--mirror} --layers "$l" -o "$s" "$b" >/dev/null 2>&1 \
    || { echo "   $n: plot failed"; return 1; }
  local a bb
  if [ -n "$m" ]; then                # --mirror maps x -> pageW - x
    a=$(python3 -c "print($PAGE_W-$x2)"); bb=$(python3 -c "print($PAGE_W-$x1)")
  else a=$x1; bb=$x2; fi
  python3 svgwin.py "$s" "$w" "$a" "$y1" "$bb" "$y2"
  local d; d=$(python3 -c "print(min(4000, max(300, round($px*25.4/($x2-$x1)))))")
  # 64 colours: these are line drawings, and 16-bit RGB costs 20x the bytes for
  # nothing a browser will show.
  magick -density "$d" -background white "$w" -resize "${px}x" \
         -strip -depth 8 -colors 64 -define png:compression-level=9 \
         "$OUT/$n.png" || echo "   $n: raster failed"
  printf '   %-22s %8s  %s\n' "$n.png" \
         "$(du -h "$OUT/$n.png" | cut -f1)" "$(identify -format '%wx%h' "$OUT/$n.png")"
}

FULL="9.8 9.9 116.4 116.1"            # the whole 106 x 105 mm board
QUAD="59.0 53.0 84.0 73.0"            # the routed stamp: cells 78/79/90/91
CELL="59.9 61.4 70.5 72.0"            # cell 78 alone, one honeycomb pitch
SEAM="66.4 58.6 72.4 71.4"            # the via ladder in the 78|79 gutter
REG="60.8 63.8 68.8 71.8"             # the 74HC595 pocket
TILES="50.5 44.5 84.5 74.5"           # four quads: does the stamp meet itself?

echo "== full board (electronics layers: $ELEC)"
shot full-wind  $FULL 2200 "$WIND,Edge.Cuts"
shot full-elec  $FULL 2200 "$ELEC,Edge.Cuts" mirror

echo "== the routed stamp"
shot quad-allcu $QUAD 1800 "$ALLCU,Edge.Cuts"
shot quad-elec  $QUAD 1800 "$ELEC,Edge.Cuts" mirror
shot quad-bcu   $QUAD 1800 "B.Cu,Edge.Cuts" mirror
shot quad-in12  $QUAD 1800 "In12.Cu,Edge.Cuts" mirror
shot quad-wind  $QUAD 1800 "$WIND,Edge.Cuts"

echo "== details"
shot cell-allcu $CELL 1500 "$ALLCU,Edge.Cuts"
shot cell-wind  $CELL 1500 "$WIND,Edge.Cuts"
shot cell-elec  $CELL 1500 "$ELEC,Edge.Cuts" mirror
shot seam-allcu $SEAM  900 "$ALLCU,Edge.Cuts"
shot reg-elec   $REG  1400 "$ELEC,Edge.Cuts" mirror
shot tiles-elec $TILES 1800 "$ELEC,Edge.Cuts" mirror

echo "== per-layer stack over the stamp (bottom view: B.Cu first)"
python3 - "$BOARD" > "$OUT/layers.json" <<'PYEOF'
import json, re, sys
t = open(sys.argv[1]).read()
cu = re.findall(r'\(\d+ "([FB]\.Cu|In\d+\.Cu)" signal\)', t)
wound = set(re.findall(r'\(arc \(start [^)]*\) \(mid [^)]*\) \(end [^)]*\) '
                       r'\(width [\d.]+\)(?: \(locked\))? \(layer "([^"]+)"', t))
json.dump([{'name': n, 'slug': n.lower().replace('.cu', '').replace('.', ''),
            'winding': n in wound} for n in reversed(cu)], sys.stdout, indent=1)
PYEOF
python3 -c "
import json
for L in json.load(open('$OUT/layers.json')): print(L['name'], L['slug'])" |
while read -r NAME SLUG; do shot "lay-$SLUG" $QUAD 1400 "$NAME" mirror; done
shot lay-edge $QUAD 1400 "Edge.Cuts" mirror

echo "== data the page quotes (measured, not typed in)"
node facts.mjs "$BOARD" $QUAD > "$OUT/facts.json" && echo "   facts.json"
node numbers.mjs amzhex > "$OUT/numbers.json" && echo "   numbers.json"
python3 summarise.py "${BOARD%.kicad_pcb}.drc.json" "$BOARD" > "$OUT/summary.txt" 2>&1 \
  && echo "   summary.txt" || echo "   summary.txt: no DRC json beside the board"

echo "== 3D"
for SIDE in top bottom; do
  [ -n "$ONLY" ] && [[ "render-$SIDE" != *"$ONLY"* ]] && continue
  timeout 1200 kicad-cli pcb render --side $SIDE --width 1600 --height 1600 \
    --quality high --background opaque --zoom 0.9 \
    -o "$OUT/render-$SIDE.png" "$BOARD" >/dev/null 2>&1 \
    && printf '   %-22s %8s\n' "render-$SIDE.png" \
              "$(du -h "$OUT/render-$SIDE.png" | cut -f1)" \
    || echo "   3D $SIDE failed or timed out"
done

echo "== done: $(ls "$OUT"/*.png | wc -l) images, $(du -sh "$OUT" | cut -f1)"
