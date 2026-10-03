#!/usr/bin/env bash
# Build route/boardvis/ -- the assembly-documentation view of the amzhex board,
# as rendered by boardvis (~/Software/boardvis: IPC-2581 in, pin-1 callouts out).
#
#   ./boardvis.sh [board.kicad_pcb]        default: out/amzhex-full.kicad_pcb
#
# Two outputs, one source:
#   ~/pcb/maglev-motor/<name>.xml   the IPC-2581 export, dropped where the live
#                                   boardvis server scans (it walks ~/pcb), so
#                                   `proj up boardvis` shows the interactive view
#                                   with the interview and the packet PDF;
#   boardvis/                       static SVG pages + checks.json + manifest,
#                                   tracked in git so the simulator's "Board
#                                   view" tab works from GitHub Pages where no
#                                   Python runs.
# The manifest records the live URL, built from the registry at generation
# time (`proj port boardvis`) rather than a literal port: the static page only
# offers that link when it is itself being served from this machine.
set -euo pipefail
cd "$(dirname "$0")"
BOARD="${1:-out/amzhex-full.kicad_pcb}"
NAME=$(basename "$BOARD" .kicad_pcb)
BV=${BV:-$HOME/Software/boardvis}
export PYTHONPATH="$BV${PYTHONPATH:+:$PYTHONPATH}"
XMLDIR=${XMLDIR:-$HOME/pcb/maglev-motor}
OUT=boardvis
mkdir -p "$OUT" "$XMLDIR"
XML="$XMLDIR/$NAME.xml"

echo "export $BOARD -> $XML"
kicad-cli pcb export ipc2581 --version C --units mm -o "$XML" "$BOARD" >/dev/null

# The top face is bare winding copper (every part is on the bottom), so the
# top page is rendered for honesty -- it says "0 parts" -- not for content.
for side in top bottom; do
  for mode in none grouped; do
    f="$OUT/${side}_${mode}.svg"
    python3 -m boardvis render "$XML" -o "$f" --side "$side" --theme screen --callouts "$mode" \
      | sed 's#^wrote .*/#  #'
  done
done
# `check` exits 1 when the board has outstanding errors; here that is the
# finding, not a failure.
python3 -m boardvis check "$XML" --json > "$OUT/checks.json" || true

LIVE_PORT=$(proj port boardvis 2>/dev/null || true)
DESIGN_ID=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$XML")
python3 - "$OUT/manifest.json" "$NAME" "$BOARD" "$XML" "$LIVE_PORT" "$DESIGN_ID" <<'EOF'
import json, sys, time, os
out, name, board, xml, port, did = sys.argv[1:]
info = json.load(open(os.path.join(os.path.dirname(out), 'checks.json')))
json.dump({
    'name': name,
    'board': 'route/' + board,
    'generated': time.strftime('%Y-%m-%d %H:%M'),
    'xmlBytes': os.path.getsize(xml),
    'live': f'http://localhost:{port}/#design={did}&side=bottom&callouts=grouped' if port else None,
    'summary': info['summary'],
    # The open interview questions, one row per part group; the per-designator
    # lists behind them are in checks.json (700 KB, not tracked) and in the live UI.
    'questions': [{k: q[k] for k in ('check', 'level', 'partLabel', 'title', 'question', 'side')}
                  | {'count': len(q.get('refs') or [q.get('ref')])} for q in info['questions']],
    'pages': {s: {m: f'{s}_{m}.svg' for m in ('none', 'grouped')} for s in ('top', 'bottom')},
}, open(out, 'w'), indent=1)
EOF
echo "wrote $OUT/manifest.json  (live: ${LIVE_PORT:-none})"
