// Merge a freerouting .ses back into the FULL .kicad_pcb.
//
// The router only ever saw the electronics layers (see mkdsn.mjs), so its
// output has to be pasted onto the real twelve-layer board before anything can
// be believed about it -- DRC on the proxy proves nothing, DRC on the merged
// board proves everything.
//
// `node mkses.mjs <board.kicad_pcb> <routed.ses> <out.kicad_pcb>`

import { readFileSync, writeFileSync } from 'fs';
import { FAB, viaDrill, minViaFor } from '../src/kicad.js';

const f = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));

/** The via to write for a board, read off the board itself. The merge step is
 *  the last place a routed via's size is decided, and it used to decide it with
 *  `VIA_DRILL || 0.2` -- a default with no board behind it, which stamped 698
 *  9.2:1 holes into a 14-layer stack. The .kicad_pcb states its own pressed
 *  thickness in its first line, so ask it. */
export function viaForBoard(board) {
  const m = board.match(/\(general\s*\(thickness ([\d.]+)\)/);
  const t = m ? +m[1] : 0;
  return { thickness: t, dia: Math.max(FAB.viaDia, minViaFor(t)), drill: viaDrill(FAB.viaDia, t) };
}

export function mergeSes(boardPath, sesPath, outPath, { viaDia, viaDrill, layers } = {}) {
  const board = readFileSync(boardPath, 'utf8');
  const ses = readFileSync(sesPath, 'utf8');

  // Unstated via geometry comes from the board's own stackup, never a constant.
  const fit = viaForBoard(board);
  if (viaDia == null) viaDia = fit.dia;
  if (viaDrill == null) viaDrill = fit.drill;
  if (fit.thickness && viaDrill * FAB.maxAspect < fit.thickness - 1e-9) {
    throw new Error(`via drill ${viaDrill} mm through ${fit.thickness} mm of board is `
      + `${(fit.thickness / viaDrill).toFixed(1)}:1, past the fab's ${FAB.maxAspect}:1 `
      + `(this board needs ${fit.drill} mm)`);
  }

  // Net name -> number, from the board's own net table.
  const netNum = new Map();
  for (const m of board.matchAll(/^  \(net (\d+) "([^"]*)"\)$/gm)) netNum.set(m[2], +m[1]);

  // The session's resolution: (resolution um 10) means coordinates are in
  // tenths of a micron. Read it rather than assuming.
  const res = ses.match(/\(resolution (\w+) (\d+)\)/);
  const unit = res ? res[1] : 'um';
  const scale = (unit === 'um' ? 1e-3 : unit === 'mm' ? 1 : 1e-3) / (res ? +res[2] : 1);
  const X = (v) => v * scale;
  const Y = (v) => -v * scale;               // DSN is y-up, the board file is y-down

  const out = [];
  let wires = 0, vias = 0, skipped = 0;

  // (net NAME (wire (path LAYER WIDTH x y x y ...)) ... (via PADSTACK x y ...))
  const netRe = /\(net "?([^"\s)]+)"?\s([\s\S]*?)\n      \)/g;
  const routes = ses.slice(ses.indexOf('(network_out'));
  for (const nm of routes.matchAll(netRe)) {
    const name = nm[1], body = nm[2];
    // The router was given each coil as a two-terminal component (coil_i_A /
    // coil_i_B, see route.mjs); on the board those are the coil's one net,
    // because the winding is what joins them.
    let num = netNum.get(name);
    if (num === undefined) num = netNum.get(name.replace(/_[AB]$/, ''));
    if (num === undefined) { skipped++; continue; }
    for (const w of body.matchAll(/\(path (\S+) (\d+)((?:\s+-?\d+)+)\s*\)/g)) {
      const layer = w[1];
      const width = +w[2] * scale;
      const nums = w[3].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 3 < nums.length; i += 2) {
        const [x0, y0, x1, y1] = [nums[i], nums[i + 1], nums[i + 2], nums[i + 3]];
        if (x0 === x1 && y0 === y1) continue;
        out.push(`  (segment (start ${f(X(x0))} ${f(Y(y0))}) (end ${f(X(x1))} ${f(Y(y1))}) (width ${f(width)}) (layer "${layer}") (net ${num}))`);
        wires++;
      }
    }
    // Routing vias span the whole stack: the board is through-hole only, and
    // the keepouts are what kept them out of the winding.
    for (const v of body.matchAll(/\(via \S+((?:\s+-?\d+){2})\s*\)/g)) {
      const [x, y] = v[1].trim().split(/\s+/).map(Number);
      out.push(`  (via (at ${f(X(x))} ${f(Y(y))}) (size ${f(viaDia)}) (drill ${f(viaDrill)}) (layers "${layers[0]}" "${layers[1]}") (net ${num}))`);
      // NOTE: `layers` is the via's SPAN and it is load-bearing. A routing via
      // written F.Cu-B.Cu is a through hole, and a through hole anywhere but
      // the gutter drills straight through the winding. Blind-via runs must
      // pass the electronics pair here, not the full stack.
      vias++;
    }
  }

  const cut = board.lastIndexOf('\n)');
  writeFileSync(outPath, board.slice(0, cut) + '\n' + out.join('\n') + board.slice(cut));
  return { wires, vias, skippedNets: skipped };
}

// argv[1] is undefined under `node -e`, which is how finish.sh imports
// viaForBoard -- an unguarded .endsWith() there threw and silently skipped
// writing the rule files while the rest of the script carried on.
if (process.argv[1]?.endsWith('mkses.mjs')) {
  const [, , b, s, o] = process.argv;
  // No numeric defaults: unset means "whatever this board's stackup allows".
  // An explicit VIA_DRILL is still honoured, but only if it is legal for the
  // board -- mergeSes throws on an over-deep hole rather than writing it.
  const r = mergeSes(b, s, o, {
    viaDia: process.env.VIA_DIA ? +process.env.VIA_DIA : null,
    viaDrill: process.env.VIA_DRILL ? +process.env.VIA_DRILL : null,
    layers: (process.env.VIA_SPAN || 'F.Cu,B.Cu').split(','),
  });
  console.log(JSON.stringify(r));
  console.log(`wrote ${o}`);
}
