import { readFileSync } from 'fs';
import { pcbCoilGeometry, viaPlan, viaSize } from '../src/kicad.js';
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const P = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = P.amzhex.cfg;
const g = pcbCoilGeometry(cfg);
const cellHalf = cfg.stator.coilPitch*1000/2;
const via = viaSize(g);
console.log('geom', JSON.stringify({...g, cellHalf, via}));
const plan = viaPlan(g, g.layers, cellHalf, via);
const all = [...plan.vias.map(v=>({t:'x',p:v.p})), ...plan.termVias.map(v=>({t:'T',p:v.p}))];
for (const v of all) console.log(v.t, 'r=', Math.hypot(...v.p).toFixed(3), 'ang=', (Math.atan2(v.p[1],v.p[0])*180/Math.PI).toFixed(1));
let min=1e9, pair=null;
for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
  const d=Math.hypot(all[i].p[0]-all[j].p[0],all[i].p[1]-all[j].p[1]);
  if(d<min){min=d;pair=[all[i],all[j]];}
}
console.log('min via-via centre dist', min.toFixed(3), pair.map(v=>v.t+' r'+Math.hypot(...v.p).toFixed(2)).join(' <-> '));
console.log('halfIn', g.halfIn.toFixed(3), 'halfOut', g.halfOut.toFixed(3), 'cellHalf', cellHalf.toFixed(3), 'gutter/side', (cellHalf-g.halfOut).toFixed(3));
console.log('termPads', JSON.stringify(plan.termPads.map(p=>({r:+Math.hypot(...p.p).toFixed(3), w:+p.w.toFixed(3), h:+p.h.toFixed(3)}))));
