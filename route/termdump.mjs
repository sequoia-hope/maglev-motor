// terminals.json for coilleads.py: where each coil's IN/OUT lead barrels are
import { readFileSync, writeFileSync } from 'fs';
import { makeStator } from '../src/coils.js';
import { pcbCoilGeometry, viaPlan, viaSize } from '../src/kicad.js';
const B = process.argv[2];
const spec = JSON.parse(readFileSync(`${B}.quads.json`, 'utf8'));
const txt = readFileSync(`${B}.kicad_pcb`, 'utf8');
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const m of txt.matchAll(/\(gr_line \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\) \(layer "Edge\.Cuts"\)/g)) { minX = Math.min(minX, +m[1], +m[3]); maxX = Math.max(maxX, +m[1], +m[3]); minY = Math.min(minY, +m[2], +m[4]); maxY = Math.max(maxY, +m[2], +m[4]); }
const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const PRESETS = {') + 'const PRESETS = '.length);
const PRESETS = eval('(' + body.slice(0, body.indexOf('\n};') + 2) + ')');
const cfg = JSON.parse(JSON.stringify(PRESETS.amzhex.cfg));
const stator = makeStator({ ...cfg.stator, ringsPerCoil: 2, segmentsPerSide: 3 });
const pitch = cfg.stator.coilPitch * 1000, g = pcbCoilGeometry(cfg);
const t = viaPlan(g, g.layers, pitch / 2, viaSize(g, pitch / 2), spec.viaPlanOpts || {}).termVias.map((v) => v.p);
writeFileSync(process.argv[3], JSON.stringify({ IN: t[0], OUT: t[1], coils: stator.coils.map((c) => [(minX + maxX) / 2 + c.x * 1000, (minY + maxY) / 2 - c.y * 1000]) }));
