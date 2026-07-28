import { readFileSync } from 'fs';
import { pcbCoilGeometry, viaSize, viaDrill, gutterFits, FAB, FAB_MIN_VIA } from '../src/kicad.js';
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const P = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
console.log('FAB_MIN_VIA', FAB_MIN_VIA.toFixed(3));
for (const [k, pr] of Object.entries(P)) {
  const cfg = pr.cfg;
  if (!/^pcb/.test(cfg.stator.coilType)) continue;
  for (const fill of (k==='amzhex' ? [cfg.stator.coilFill, 0.83, 0.82, 0.81, 0.80] : [cfg.stator.coilFill])) {
    const c = { stator: { ...cfg.stator, coilFill: fill } };
    const g = pcbCoilGeometry(c);
    const cellHalf = c.stator.coilPitch*1000/2;
    const f = gutterFits(g, cellHalf);
    const d = viaSize(g, cellHalf);
    console.log(`${k.padEnd(10)} fill=${fill.toFixed(3)} turns/layer=${g.turns} gutter=${f.have.toFixed(3)} need=${f.need.toFixed(3)} slack=${f.slack.toFixed(3)} ${f.ok?'OK ':'TIGHT'} via=${d.toFixed(3)}/${viaDrill(d).toFixed(3)} ring=${((d-viaDrill(d))/2).toFixed(3)}`);
  }
}
