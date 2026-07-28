// Check -- and optionally correct -- the plated-hole aspect ratio of every via
// in an existing board.
//
// The generator now sizes vias from the stack (see fabRuleFiles and route.mjs),
// but boards emitted before that carry vias drilled to a flat 0.2 mm whatever
// the thickness. On a 12-layer board (1.57 mm) that is 7.9:1 and fine; on the
// 14-layer one (1.84 mm) it is 9.2:1, past what this fab plates -- and no DRC
// rule caught it, because every rule was a diameter and the limit is a ratio.
//
// Re-drilling in place is exactly what re-merging the .ses would produce: the
// via positions come from the router and do not move, only the hole number
// changes. The land stays 0.5 mm, so the annular ring narrows 0.15 -> 0.135 mm
// and is still past the fab's 0.13 mm minimum. Hole-to-hole spacing tightens by
// the same 0.03 mm, which is why this re-runs DRC rather than trusting itself.
//
//   node redrill.mjs <board.kicad_pcb> [--fix]

import { readFileSync, writeFileSync } from 'fs';
import { FAB } from '../src/kicad.js';
import { viaForBoard } from './mkses.mjs';

const path = process.argv[2];
const fix = process.argv.includes('--fix');
if (!path) { console.error('usage: node redrill.mjs <board.kicad_pcb> [--fix]'); process.exit(2); }

const board = readFileSync(path, 'utf8');
const fit = viaForBoard(board);
if (!fit.thickness) { console.error(`${path}: no (general (thickness ...)) -- cannot judge aspect ratio`); process.exit(2); }

const viaRe = /\(via \(at [^)]*\) \(size ([\d.]+)\) \(drill ([\d.]+)\)/g;
const counts = new Map();
for (const m of board.matchAll(viaRe)) {
  const k = `${m[1]}/${m[2]}`;
  counts.set(k, (counts.get(k) || 0) + 1);
}

console.log(`${path}: ${fit.thickness} mm board, fab plates ${FAB.maxAspect}:1 -> min drill ${fit.drill} mm`);
let bad = 0;
for (const [k, n] of [...counts].sort()) {
  const [size, drill] = k.split('/').map(Number);
  const aspect = fit.thickness / drill;
  const over = aspect > FAB.maxAspect + 1e-9;
  if (over) bad += n;
  console.log(`  ${String(n).padStart(5)}  size ${size} drill ${drill}  ${aspect.toFixed(1)}:1  ${over ? 'OVER' : 'ok'}`);
}

if (!bad) { console.log('  all vias within the aspect limit'); process.exit(0); }
if (!fix) { console.log(`  ${bad} vias over the limit -- rerun with --fix`); process.exit(1); }

// Only the drill is rewritten. A via whose land cannot hold the wider hole with
// a legal ring is grown too, but on these boards the 0.5 mm land already can.
let changed = 0;
const out = board.replace(/(\(via \(at [^)]*\) \(size ([\d.]+)\) \(drill )([\d.]+)(\))/g,
  (all, head, size, drill, tail) => {
    if (fit.thickness / +drill <= FAB.maxAspect + 1e-9) return all;
    const ring = (+size - fit.drill) / 2;
    if (ring < FAB.minAnnular - 1e-9) {
      throw new Error(`via land ${size} mm cannot hold a ${fit.drill} mm hole: ring ${ring.toFixed(3)} < ${FAB.minAnnular}`);
    }
    changed++;
    return head + fit.drill + tail;
  });
writeFileSync(path, out);
console.log(`  re-drilled ${changed} vias to ${fit.drill} mm (ring ${((0.5 - fit.drill) / 2).toFixed(3)} mm)`);
