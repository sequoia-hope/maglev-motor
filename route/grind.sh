#!/usr/bin/env bash
# Keep routing the full board until it stops improving.
#
# The 168-coil board does not converge the way the 3x3 tile does -- it was still
# gaining ~70 connections a pass when a 12-pass run ended. So this runs
# freerouting in rounds, and after each round merges what it achieved back onto
# the board and hands that back as the starting point (route.mjs CARRY), which
# is what makes the progress compound instead of restarting.
#
# Stops when a round gains less than MIN_GAIN, or after MAX_ROUNDS.
#
#   ./grind.sh [rounds] [passes-per-round]
set -u
ROUNDS="${1:-8}"
PASSES="${2:-10}"
MIN_GAIN="${MIN_GAIN:-15}"

# Settings only reach freerouting through these -- a freerouting.json in the
# working directory is silently ignored (see README).
export FREEROUTING__ROUTER__SCORING__VIA_COSTS=10
export FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000

BOARD=amzhex.kicad_pcb
CUR="${SEED:-}"             # board carrying the best result so far
prev=999999

for r in $(seq 1 "$ROUNDS"); do
  echo "=== round $r  ($(date +%H:%M:%S))"
  if [ -z "$CUR" ]; then
    DSN_OUT=grind.dsn node route.mjs amzhex "$BOARD" >/dev/null
  else
    CARRY="$CUR" DSN_OUT=grind.dsn node route.mjs amzhex "$BOARD" | grep -E "carried" || true
  fi

  timeout 10800 java -Xmx16g -jar freerouting-2.2.4.jar \
    -de grind.dsn -do "grind$r.ses" -mp "$PASSES" -mt 16 2>&1 \
    | tee "grind$r.router.log" \
    | grep -oE "session completed.*" | tail -1
  [ -s "grind$r.ses" ] || { echo "   no session output; stopping"; break; }

  node mkses.mjs "$BOARD" "grind$r.ses" "grind$r.kicad_pcb" | tail -1
  CUR="grind$r.kicad_pcb"

  # The number that matters is what KiCad thinks is still unconnected on the
  # real twelve-plus-two layer board, not the router's own tally.
  left=$(python3 - "$CUR" <<'PY'
import sys
try:
    import pcbnew
    b = pcbnew.LoadBoard(sys.argv[1])
    cn = b.GetConnectivity(); cn.RecalculateRatsnest()
    print(cn.GetUnconnectedCount(True))
except Exception:
    print(-1)
PY
)
  echo "   unconnected on the real board: $left"
  gain=$(( prev - left ))
  if [ "$prev" -ne 999999 ] && [ "$gain" -lt "$MIN_GAIN" ]; then
    echo "   gained only $gain this round; stopping"
    break
  fi
  prev=$left
done

echo "=== finishing with $CUR"
[ -n "$CUR" ] && ./finish.sh "$BOARD" "$(ls -t grind*.ses | head -1)" amzhex-routed
