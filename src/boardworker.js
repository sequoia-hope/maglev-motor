// Board-build worker: the collision-checked electronics placement plan is tens
// of seconds of solid arithmetic on a 168-cell board, and it used to run on
// the UI thread -- selecting a driver-per-coil preset froze the whole tab.
// The modules are dependency-free ES modules, so this worker just imports the
// same code the tests run and does the identical build off-thread.
//
// Protocol:
//   -> { type: 'build', key, cfg: {stator}, quality: {ringsPerCoil, segmentsPerSide}, sensorSpacing }
//   <- { type: 'built', key, stats, contract, elec, bpStats, bpContract }
//   -> { type: 'text', key, which: 'coil'|'backplane'|'tile'|'tileBp' }
//   <- { type: 'text', key, which, text }        (or error: 'stale')
//
// The board text (tens of MB for a full honeycomb) stays HERE: the UI only
// ever receives stats, and asks for a file when a download button is clicked.
// A 'build' for a new key drops the old boards -- one design is held at a time.

import { makeStator } from './coils.js';
import { buildKiCad, buildDriverBackplane, buildTile } from './kicad.js';

let held = null;

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'build') {
    const stator = makeStator({
      ...m.cfg.stator,
      ringsPerCoil: m.quality.ringsPerCoil,
      segmentsPerSide: m.quality.segmentsPerSide,
    });
    const kc = buildKiCad(stator, m.cfg, { sensorSpacing: m.sensorSpacing ?? null });
    const bp = buildDriverBackplane(stator, m.cfg);
    held = { key: m.key, cfg: m.cfg, kc, bp };
    postMessage({
      type: 'built', key: m.key,
      stats: kc.stats, contract: kc.contract, elec: kc.elec,
      bpStats: bp.stats, bpContract: bp.contract,
    });
  } else if (m.type === 'text') {
    if (!held || held.key !== m.key) {
      postMessage({ type: 'text', key: m.key, which: m.which, error: 'stale' });
      return;
    }
    const text = m.which === 'coil' ? held.kc.text
      : m.which === 'backplane' ? held.bp.text
        : m.which === 'tile' ? buildTile(held.cfg, 3).text
          : m.which === 'tileBp' ? buildTile(held.cfg, 3, true).text
            : null;
    postMessage({ type: 'text', key: m.key, which: m.which, text });
  }
};
