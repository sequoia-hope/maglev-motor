import { readFileSync, writeFileSync } from 'fs';
const src = readFileSync('bs_notrack.kicad_pcb','utf8').split('\n');
function keepOnly(types){
  const out=[]; let fp=0, buf=[], keep=false;
  for(const l of src){
    if(!fp && /^\s*\(footprint /.test(l)){ fp=1; buf=[l]; keep=types.some(t=>l.includes(`"maglev:${t}"`)); continue; }
    if(fp){ buf.push(l); if(/^\s{2}\)\s*$/.test(l)){ fp=0; if(keep) out.push(...buf); } continue; }
    out.push(l);
  }
  return out.join('\n');
}
for(const t of ['C0402','DFN8HB','HDR10','R0402','SOT23','SR595Q','Term','TMAG'])
  writeFileSync(`fp_${t}.kicad_pcb`, keepOnly([t]));
console.log('ok');
