#!/bin/bash
# Sweep single-cell arrangements: each variant is (U_AT, C_AT, SR_AT) env
# overrides for cellgen (empty = let the search choose). Each is generated,
# turned into the centre-cell routing problem, autorouted, and scored by the
# router's own summary line (unrouted + violations).
set -e
cd "$(dirname "$0")"
PASSES=${PASSES:-60}
run() {
  local tag="$1" u="$2" c="$3" s="$4"
  OUT_KEY="sw_$tag" U_AT="$u" C_AT="$c" SR_AT="$s" node cellgen.mjs amzhex 3 > "sw_$tag.gen.log" 2>&1 || { echo "$tag: GEN FAILED"; return; }
  node cellroute.mjs "sw_$tag.kicad_pcb" "sw_$tag.dsn" > "sw_$tag.route.log" 2>&1
  FREEROUTING__ROUTER__SCORING__VIA_COSTS=10 FREEROUTING__ROUTER__SCORING__START_RIPUP_COSTS=1000 \
  java -Xss512m -Xmx4g -jar freerouting-2.2.4.jar -de "sw_$tag.dsn" -do "sw_$tag.ses" -mp "$PASSES" > "sw_$tag.router.log" 2>&1 || true
  local line
  line=$(grep -o 'final score.*' "sw_$tag.router.log" | tail -1)
  echo "$tag: $line   [$(grep -E 'bridge at|decap at|register at' "sw_$tag.gen.log" | tr '\n' ';')]"
}
for v in "$@"; do
  IFS='|' read -r tag u c s <<< "$v"
  run "$tag" "$u" "$c" "$s"
done
