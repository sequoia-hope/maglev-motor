import { readFileSync, writeFileSync } from 'fs';
const src = readFileSync('tile3.kicad_pcb','utf8').split('\n');
const variants = {
  nofp:   (l) => !inFp(l),
  notrack:(l) => !/^\s*\((segment|arc|via) /.test(l),
  noarc:  (l) => !/^\s*\(arc /.test(l),
  novia:  (l) => !/^\s*\(via /.test(l),
  onlyoutline: (l) => !inFp(l) && !/^\s*\((segment|arc|via) /.test(l),
};
let depth=0;
function inFp(l){ return false; }
// crude footprint stripper: track brace depth from '(footprint'
function strip(pred, dropFp){
  const out=[]; let fp=0;
  for(const l of src){
    if(dropFp && /^\s*\(footprint /.test(l)){ fp=1; continue; }
    if(fp){ if(/^\s{2}\)\s*$/.test(l)) fp=0; continue; }
    if(!pred(l)) continue;
    out.push(l);
  }
  return out.join('\n');
}
const cases = [
  ['nofp', (l)=>true, true],
  ['notrack', (l)=>!/^\s*\((segment|arc|via) /.test(l), false],
  ['noarc', (l)=>!/^\s*\(arc /.test(l), false],
  ['novia', (l)=>!/^\s*\(via /.test(l), false],
  ['bare', (l)=>!/^\s*\((segment|arc|via) /.test(l), true],
];
for(const [name,pred,dropFp] of cases) writeFileSync(`bs_${name}.kicad_pcb`, strip(pred,dropFp));
console.log('written');
