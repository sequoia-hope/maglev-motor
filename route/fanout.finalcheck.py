# Assemble a FULL pin map for the union verdict: the R2 stage pins (taps with
# join semantics, bare SR pads, U pads, anchors) PLUS the six SR pads whose
# escape is constructed copper -- the union .ses contains that copper, so the
# check closes end-to-end: SR pad -> stub -> routed -> tap/lane.
import json, sys, subprocess
pins = json.load(open('qlane.r2.pins.json'))
stub = json.load(open('qlane.lanes.srstub.json'))
spec = json.load(open('qlane.quads.json'))
cq = spec['centreQuad']
import re
board = open('qlane.kicad_pcb').read()
# cheap footprint scrape: find SR<cq> instance, then its pads
# (positions in the file are absolute? no -- pad at is relative; use the
# known values from lanegen's frame instead: re-derive via node)
out = subprocess.run(['node','-e','''
import("./mkdsn.mjs").then(async ({readBoard}) => {
  const b = readBoard("qlane.kicad_pcb");
  const sr = b.fps.find(f => f.ref === "SR"+%d);
  const map = {};
  for (const p of sr.pads) map[p.name] = {x:+(sr.x+p.dx).toFixed(3), y:+(sr.y+p.dy).toFixed(3), net:p.netName};
  console.log(JSON.stringify(map));
})''' % cq], capture_output=True, text=True)
srpads = json.loads(out.stdout)
ren = {'VLOGIC':'VLOGIC_C','GND':'GND_C','VBUS':'VBUS_C','SCLK':'SCLK_C','RCLK':'RCLK_C','OE_N':'OE_N_C',
       'DATA_%d'%cq:'DATA_W','DATA_%d'%(cq+1):'DATA_E'}
for pd in stub:
    g = srpads[pd]
    net = 'VLOGIC_CW' if pd == '4' else ren.get(g['net'], g['net'])
    pins.append({'net': net, 'x': g['x'], 'y': g['y'],
                 'label': 'SR.'+pd, 'w': 0.3, 'h': 0.8})
json.dump(pins, open('qlane.final.pins.json','w'))
print('final pin map:', len(pins), 'pins incl', len(stub), 'constructed SR pads')
