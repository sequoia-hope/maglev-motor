// Everything the report page quotes about the copper, measured from the board
// file rather than typed in beside it.
//   node facts.mjs <board.kicad_pcb> [x1 y1 x2 y2]   -> facts.json on stdout
import { readFileSync } from 'fs';
import { pcbCoilGeometry } from '../src/kicad.js';

const path = process.argv[2] || 'fabtest.merged.kicad_pcb';
const win = process.argv.length > 6 ? process.argv.slice(3, 7).map(Number) : null;
const t = readFileSync(path, 'utf8');

const cu = [...t.matchAll(/\(\d+ "([FB]\.Cu|In\d+\.Cu)" signal\)/g)].map((m) => m[1]);
// Only the spirals are drawn with arcs (filleted corners), so an arc is the
// signature of a winding layer -- an item count is not (see eleclayers.py).
const wound = new Set([...t.matchAll(
  /\(arc \(start [^)]*\) \(mid [^)]*\) \(end [^)]*\) \(width [\d.]+\)(?: \(locked\))? \(layer "([^"]+)"/g)]
  .map((m) => m[1]));

const nets = new Map();
for (const m of t.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) nets.set(+m[1], m[2]);
const cls = (n) => n.replace(/\d+$/, '#');

const vias = { total: 0, byClass: {}, size: new Set(), drill: new Set() };
for (const m of t.matchAll(
  /\(via \(at ([-\d.]+) ([-\d.]+)\) \(size ([\d.]+)\) \(drill ([\d.]+)\)[\s\S]{0,200}?\(net (\d+)\)/g)) {
  vias.total++;
  vias.size.add(+m[3]); vias.drill.add(+m[4]);
  const k = cls(nets.get(+m[5]) || '?');
  vias.byClass[k] = (vias.byClass[k] || 0) + 1;
}
vias.size = [...vias.size]; vias.drill = [...vias.drill];

const segsByLayer = {};
for (const m of t.matchAll(/^  \((?:segment|arc)[^\n]*\(layer "([^"]+)"/gm)) {
  segsByLayer[m[1]] = (segsByLayer[m[1]] || 0) + 1;
}

const parts = [], refs = {};
for (const m of t.matchAll(/^  \(footprint "([^"]+)" \(layer "([^"]+)"\) \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)([\s\S]*?)\n  \)$/gm)) {
  const ref = (m[6].match(/\(fp_text reference "([^"]+)"/) || [])[1] || '?';
  const val = (m[6].match(/\(fp_text value "([^"]+)"/) || [])[1] || '';
  const lcsc = (m[6].match(/\(property "LCSC" "([^"]+)"/) || [])[1] || '';
  const k = ref.replace(/\d+$/, '');
  refs[k] = refs[k] || { n: 0, footprint: m[1], value: val, lcsc };
  refs[k].n++;
  if (win && +m[3] >= win[0] && +m[3] <= win[2] && +m[4] >= win[1] && +m[4] <= win[3]) {
    parts.push({ ref, x: +(+m[3]).toFixed(3), y: +(+m[4]).toFixed(3), rot: +(m[5] || 0) });
  }
}

const edge = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9, segs: 0 };
for (const m of t.matchAll(/\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)/g)) {
  edge.segs++;
  for (const [x, y] of [[+m[1], +m[2]], [+m[3], +m[4]]]) {
    edge.minX = Math.min(edge.minX, x); edge.maxX = Math.max(edge.maxX, x);
    edge.minY = Math.min(edge.minY, y); edge.maxY = Math.max(edge.maxY, y);
  }
}
edge.width = +(edge.maxX - edge.minX).toFixed(3);
edge.height = +(edge.maxY - edge.minY).toFixed(3);

const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));

console.log(JSON.stringify({
  board: path,
  outline: edge,
  layers: { all: cu, winding: cu.filter((l) => wound.has(l)), electronics: cu.filter((l) => !wound.has(l)) },
  vias,
  segsByLayer,
  parts: { counts: refs, inWindow: parts, window: win },
  coil: pcbCoilGeometry(cfg),
  stator: cfg.stator,
  translator: cfg.translator,
}, null, 1));
