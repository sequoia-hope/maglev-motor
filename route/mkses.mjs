// Merge a freerouting .ses back into the FULL .kicad_pcb.
//
// The router only ever saw the electronics layers (see mkdsn.mjs), so its
// output has to be pasted onto the real twelve-layer board before anything can
// be believed about it -- DRC on the proxy proves nothing, DRC on the merged
// board proves everything.
//
// `node mkses.mjs <board.kicad_pcb> <routed.ses> <out.kicad_pcb>`

import { readFileSync, writeFileSync } from 'fs';

const f = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(6));

export function mergeSes(boardPath, sesPath, outPath, { viaDia, viaDrill, layers }) {
  const board = readFileSync(boardPath, 'utf8');
  const ses = readFileSync(sesPath, 'utf8');

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

if (process.argv[1].endsWith('mkses.mjs')) {
  const [, , b, s, o] = process.argv;
  const r = mergeSes(b, s, o, {
    viaDia: +(process.env.VIA_DIA || 0.5),
    viaDrill: +(process.env.VIA_DRILL || 0.2),
    layers: (process.env.VIA_SPAN || 'F.Cu,B.Cu').split(','),
  });
  console.log(JSON.stringify(r));
  console.log(`wrote ${o}`);
}
