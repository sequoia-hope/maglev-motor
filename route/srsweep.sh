#!/bin/bash
# Drive the SR-placement sweep (SR rotation co-design): every shortlisted
# candidate from qlane.srscan.json through srsweep-one.sh, three at a time.
# Results accumulate in srsweep.results.log; rank by the miss count column.
set -eu
cd "$(dirname "$0")"
: > srsweep.results.log
python3 - <<'EOF' > srsweep.cands.txt
import json
d = json.load(open('qlane.srscan.json'))
seen, rows = [], []
for c in d['picked']:
    # drop near-duplicates (within 0.15 mm and 10 deg of an earlier pick)
    if any(abs(c['rx']-p['rx'])<0.15 and abs(c['ry']-p['ry'])<0.15
           and min((c['rdeg']-p['rdeg'])%360,(p['rdeg']-c['rdeg'])%360)<=10 for p in seen):
        continue
    seen.append(c)
    rows.append(f"srswp{len(rows)} {c['rx']} {c['ry']} {c['rdeg']}")
print('\n'.join(rows))
EOF
echo "== candidates:"; cat srsweep.cands.txt
xargs -P 3 -n 4 ./srsweep-one.sh < srsweep.cands.txt
echo "== sweep done"
sort -t$'\t' -k5 -n srsweep.results.log | column -t -s$'\t'
