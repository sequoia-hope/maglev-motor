#!/usr/bin/env python3
"""Name the electronics layers of a generated board: the copper layers with no
winding on them.

Tell them apart by ARCS, not by item count. Only the spirals are drawn with
arcs -- their corners are filleted so each crossover via drops into a
copper-free pocket -- while a router lays nothing but straight segments. A
count-based rule looks reasonable and is not: on the 3x3 tile B.Cu carries 338
items against a winding layer's 1341, and a "less than a quarter of the busiest"
threshold puts it at 335, so B.Cu was classified as WINDING and every
electronics render came out missing the parts and most of the routing.
"""
import re
import sys

txt = open(sys.argv[1]).read()
cu = re.findall(r'\(\d+ "([FB]\.Cu|In\d+\.Cu)" signal\)', txt)
wound = set(re.findall(r'\(arc \(start [^)]*\) \(mid [^)]*\) \(end [^)]*\) \(width [\d.]+\) \(layer "([^"]+)"', txt))
elec = [L for L in cu if L not in wound]
print(','.join(elec) or 'B.Cu')
