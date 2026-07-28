import { readFileSync, writeFileSync } from 'fs';
import { buildTile } from '../src/kicad.js';
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS[process.argv[2]||'amzhex'].cfg));
if (process.env.SPARE) cfg.stator.pcbSpareLayers = +process.env.SPARE;
if (process.env.LAYERS) cfg.stator.pcbLayers = +process.env.LAYERS;
if (process.env.FILL) cfg.stator.coilFill = +process.env.FILL;
if (process.env.INNER) cfg.stator.pcbInnerFrac = +process.env.INNER;  // PCB_INNER_FRAC override
const n = +(process.argv[3]||3);
const t = buildTile(cfg, n);
console.log(JSON.stringify(t.stats, null, 1));
writeFileSync(new URL(process.env.TILE_OUT || `./tile${n}.kicad_pcb`, import.meta.url), t.text);
