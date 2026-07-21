// App shell: parameter UI, design analyses, and the real-time flight loop.

import { quat, clamp } from './math.js';
import { ARRAY_TYPES, makeTranslator, selfTest } from './halbach.js';
import { COIL_TYPES, makeStator } from './coils.js';
import { analysePose, buildWrench, allocatePrioritised, copperLoss, makeState, step } from './physics.js';
import { makeController, control, TRAJECTORIES, makeDisturbance, applyDisturbance, kick } from './control.js';
import { render, makeCamera, fitCamera, attachOrbit, theme } from './render3d.js';
import { lineChart, heatmap, barStrip, trackHover } from './plots.js';
import { fieldMap, liftVsGap, pitchSweep, capabilityMap, rippleScan, thermal } from './analysis.js';

// ---------------------------------------------------------------- presets ---

const PRESETS = {
  pcb: {
    label: 'Desktop PCB stage (buildable)',
    blurb: 'One tileable 96 mm PCB stator tile, small 2-D Halbach platen. No coil winding — but 144 coils still means 144 driver channels, and the 1.5 mm gap is unforgiving.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single', pitch: 0.024, magnetThickness: 0.003, Br: 1.43, segments: 4, platenSize: 0.072, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'pcb', coilPitch: 0.008, coilFill: 0.94, statorSize: 0.096, windingHeight: 0.0016, wireDiameter: 0.0005, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.0015, iMax: 4, bwPos: 22, bwAtt: 40, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced' },
    },
  },
  wound: {
    label: 'Hand-wound square coils (Zhu/Teo/Pang)',
    blurb: 'Four 1-D Halbach arrays in a cross over a grid of square coils. Every part is off-the-shelf: cube magnets and magnet wire.',
    cfg: {
      translator: { arrayType: 'halbach1d', layout: 'quad', pitch: 0.040, magnetThickness: 0.010, Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.0133, coilFill: 0.92, statorSize: 0.30, windingHeight: 0.010, wireDiameter: 0.0004, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.003, iMax: 6, bwPos: 16, bwAtt: 30, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced' },
    },
  },
  racetrack: {
    label: 'Racetrack stator (Jansen / ASML)',
    blurb: 'Two orthogonal banks of segmented, staggered rectangular coils under a 2-D Halbach platen. Fewest driver channels per unit stroke, and the topology real lithography stages use — but it runs hot and its lift ripples most across the workspace.',
    cfg: {
      translator: { arrayType: 'halbach2d', layout: 'single', pitch: 0.050, magnetThickness: 0.003, Br: 1.43, segments: 4, platenSize: 0.12, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'racetrack', coilPitch: 0.0167, coilFill: 0.9, statorSize: 0.30, windingHeight: 0.009, wireDiameter: 0.0006, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.0015, iMax: 8, bwPos: 14, bwAtt: 26, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced' },
    },
  },
  baseline: {
    label: 'Baseline: plain N/S array',
    blurb: 'Identical machine with the flux-steering magnets removed. Run it to see exactly what the Halbach geometry buys you.',
    cfg: {
      translator: { arrayType: 'alternating', layout: 'single', pitch: 0.040, magnetThickness: 0.010, Br: 1.32, segments: 4, platenSize: 0.14, platenMass: 0, maxOrder: 3 },
      stator: { coilType: 'square', coilPitch: 0.0133, coilFill: 0.92, statorSize: 0.30, windingHeight: 0.010, wireDiameter: 0.0004, pcbLayers: 16, pcbTraceWidth: 0.00025, pcbCopperThickness: 70e-6, lockCoilPitch: false },
      sim: { gap: 0.003, iMax: 6, bwPos: 16, bwAtt: 30, zeta: 1.0, kiPos: 0.6, kiAtt: 0.6, maxTilt: 0.06, quality: 'balanced' },
    },
  },
};

const QUALITY = {
  fast: { segmentsPerSide: 2, ringsPerCoil: 1, maxOrder: 2, controlHz: 400, label: 'Fast' },
  balanced: { segmentsPerSide: 3, ringsPerCoil: 2, maxOrder: 3, controlHz: 600, label: 'Balanced' },
  accurate: { segmentsPerSide: 5, ringsPerCoil: 3, maxOrder: 4, controlHz: 1000, label: 'Accurate' },
};

// ----------------------------------------------------------- param schema ---

const mm = { scale: 1000, unit: 'mm', digits: 1 };
const PARAMS = [
  {
    title: 'Magnet array (translator)',
    fields: [
      { path: 'translator.arrayType', type: 'select', label: 'Array topology',
        options: Object.entries(ARRAY_TYPES).map(([k, v]) => [k, v.label]),
        help: (cfg) => ARRAY_TYPES[cfg.translator.arrayType].note },
      { path: 'translator.layout', type: 'select', label: 'Platen layout',
        options: [['single', 'One continuous array'], ['quad', 'Four arrays in a cross']],
        help: () => 'A cross of four 1-D arrays is the classic way to get all six DOF from single-axis Halbach strips. A single 2-D array does it alone.' },
      { path: 'translator.pitch', type: 'range', label: 'Pole pitch λ', min: 0.008, max: 0.080, step: 0.001, ...mm,
        help: () => 'The dominant design variable. Air-gap field decays as exp(−2πz/λ), so usable flying height scales directly with pitch.' },
      { path: 'translator.segments', type: 'range', label: 'Magnets per wavelength', min: 2, max: 8, step: 1, scale: 1, unit: '', digits: 0,
        help: () => 'Discretisation of the ideal rotating magnetisation. Amplitude penalty is sin(π/M)/(π/M): 0.64 at M=2, 0.90 at M=4, 0.96 at M=6.' },
      { path: 'translator.magnetThickness', type: 'range', label: 'Magnet thickness', min: 0.002, max: 0.030, step: 0.001, ...mm,
        help: () => 'Diminishing returns past about λ/4: the (1−exp(−k·D)) term saturates.' },
      { path: 'translator.Br', type: 'range', label: 'Remanence Br', min: 0.4, max: 1.45, step: 0.01, scale: 1, unit: 'T', digits: 2,
        help: () => 'N52 NdFeB ≈ 1.43 T, N42 ≈ 1.32 T, SmCo ≈ 1.05 T, ferrite ≈ 0.4 T.' },
      { path: 'translator.platenSize', type: 'range', label: 'Platen size', min: 0.03, max: 0.30, step: 0.005, ...mm },
      { path: 'translator.platenMass', type: 'range', label: 'Platen mass (0 = auto)', min: 0, max: 5, step: 0.01, scale: 1000, unit: 'g', digits: 0,
        help: () => 'Auto estimates magnet mass at 7500 kg/m³ plus 60% for structure.' },
    ],
  },
  {
    title: 'Coil array (stator)',
    fields: [
      { path: 'stator.coilType', type: 'select', label: 'Coil topology',
        options: Object.entries(COIL_TYPES).map(([k, v]) => [k, v.label]),
        help: (cfg) => COIL_TYPES[cfg.stator.coilType].note },
      { path: 'stator.coilPitch', type: 'range', label: 'Coil pitch', min: 0.004, max: 0.060, step: 0.001, ...mm,
        help: (c) => `Use λ/3 (${(c.translator.pitch / 3 * 1000).toFixed(1)} mm here). At exactly λ/2 the coil grid lands in phase with the magnets and lateral force cancels identically at symmetric poses — watch the capability map collapse if you try it.` },
      { path: 'stator.coilFill', type: 'range', label: 'Coil fill fraction', min: 0.5, max: 1.0, step: 0.01, scale: 100, unit: '%', digits: 0 },
      { path: 'stator.statorSize', type: 'range', label: 'Stator size', min: 0.05, max: 0.6, step: 0.01, ...mm },
      { path: 'stator.windingHeight', type: 'range', label: 'Winding build height', min: 0.001, max: 0.020, step: 0.0005, ...mm, digits: 1,
        show: (c) => c.stator.coilType !== 'pcb',
        help: () => 'How tall the winding stands off the board. Turn count is DERIVED from this and the wire gauge (70% packing) — you cannot ask for turns that do not fit. Taller means more turns but also more air gap consumed.' },
      { path: 'stator.wireDiameter', type: 'range', label: 'Wire diameter', min: 0.0002, max: 0.002, step: 0.00005, scale: 1000, unit: 'mm', digits: 2,
        show: (c) => c.stator.coilType !== 'pcb',
        help: (c) => `Thicker wire cuts copper loss but fewer turns fit, and force is proportional to turns. Current build: ${app.stator ? app.stator.effTurns : '?'} turns per coil.` },
      { path: 'stator.pcbLayers', type: 'range', label: 'PCB copper layers', min: 2, max: 32, step: 2, scale: 1, unit: '', digits: 0,
        show: (c) => c.stator.coilType === 'pcb' },
      { path: 'stator.pcbTraceWidth', type: 'range', label: 'Trace width / pitch', min: 0.0001, max: 0.001, step: 0.00001, scale: 1000, unit: 'mm', digits: 3,
        show: (c) => c.stator.coilType === 'pcb',
        help: () => 'Trace + space. 0.1 mm is standard, 0.075 mm is cheap-fab advanced, below that gets expensive fast.' },
      { path: 'stator.pcbCopperThickness', type: 'range', label: 'Copper weight', min: 17.5e-6, max: 210e-6, step: 17.5e-6, scale: 1e6, unit: 'µm', digits: 0,
        show: (c) => c.stator.coilType === 'pcb',
        help: () => '35 µm = 1 oz, 70 µm = 2 oz. This sets your resistance and therefore your thermal ceiling.' },
    ],
  },
  {
    title: 'Operating point',
    fields: [
      { path: 'sim.gap', type: 'range', label: 'Nominal air gap', min: 0.0005, max: 0.030, step: 0.0005, ...mm, digits: 2 },
      { path: 'sim.iMax', type: 'range', label: 'Current limit per coil', min: 0.2, max: 30, step: 0.1, scale: 1, unit: 'A', digits: 1 },
      { path: 'sim.quality', type: 'select', label: 'Solver quality',
        options: Object.entries(QUALITY).map(([k, v]) => [k, v.label]),
        help: (c) => `${QUALITY[c.sim.quality].controlHz} Hz control rate, harmonics to order ${QUALITY[c.sim.quality].maxOrder}, ${QUALITY[c.sim.quality].segmentsPerSide * 4 * QUALITY[c.sim.quality].ringsPerCoil} filaments per coil.` },
    ],
  },
  {
    title: 'Controller',
    fields: [
      { path: 'sim.bwPos', type: 'range', label: 'Position bandwidth', min: 2, max: 80, step: 1, scale: 1, unit: 'rad/s', digits: 0,
        help: () => 'Maglev has zero passive stiffness, so all of it comes from here. Push it until the loop starts fighting the current limit.' },
      { path: 'sim.bwAtt', type: 'range', label: 'Attitude bandwidth', min: 4, max: 150, step: 1, scale: 1, unit: 'rad/s', digits: 0 },
      { path: 'sim.zeta', type: 'range', label: 'Damping ratio', min: 0.3, max: 2.0, step: 0.05, scale: 1, unit: '', digits: 2 },
      { path: 'sim.kiPos', type: 'range', label: 'Integral action (pos)', min: 0, max: 2, step: 0.05, scale: 1, unit: '', digits: 2 },
      { path: 'sim.kiAtt', type: 'range', label: 'Integral action (att)', min: 0, max: 2, step: 0.05, scale: 1, unit: '', digits: 2 },
    ],
  },
];

// ------------------------------------------------------------------ state ---

const app = {
  presetKey: 'pcb',
  cfg: null,
  tr: null,
  stator: null,
  analysis: null,
  state: null,
  ctrl: null,
  dist: makeDisturbance(),
  camDesign: makeCamera(),
  camSim: makeCamera(),
  running: true,
  tab: 'design',
  traj: 'hover',
  trajParams: { gap: 0.0015, amplitude: 0.025, speed: 2, tiltAmp: 0.02 },
  hist: null,
  charts: new Map(),
  pitchRows: null,
  lastFrame: 0,
};

const deep = (o) => JSON.parse(JSON.stringify(o));
const get = (o, path) => path.split('.').reduce((a, k) => a[k], o);
const set = (o, path, v) => {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
};

function loadPreset(key) {
  app.presetKey = key;
  app.cfg = deep(PRESETS[key].cfg);
  rebuild(true);
  buildParamUI();
}

function rebuild(resetSim = false) {
  const q = QUALITY[app.cfg.sim.quality];
  app.tr = makeTranslator({
    ...app.cfg.translator,
    gap: app.cfg.sim.gap,
    maxOrder: q.maxOrder,
  });
  app.stator = makeStator({
    ...app.cfg.stator,
    ringsPerCoil: q.ringsPerCoil,
    segmentsPerSide: q.segmentsPerSide,
  });
  app.analysis = analysePose(
    app.stator, app.tr, [0, 0, app.cfg.sim.gap], quat.identity(), app.cfg.sim.iMax);
  app.pitchRows = null;
  app.trajParams.gap = app.cfg.sim.gap;
  for (const cam of [app.camDesign, app.camSim]) {
    fitCamera(cam, app.cfg.stator.statorSize, app.cfg.translator.platenSize, app.cfg.sim.gap);
  }

  if (resetSim || !app.state) resetSimulation();
  app.ctrl = makeController(app.cfg.sim);
  redrawAll();
}

function resetSimulation() {
  app.state = makeState(app.tr, app.cfg.sim.gap);
  app.ctrl = makeController(app.cfg.sim);
  app.dist = makeDisturbance();
  app.dist.noise = +document.getElementById('noiseSlider').value;
  app.hist = { t: [], ex: [], ey: [], ez: [], ax: [], ay: [], az: [], ip: [], pw: [], trail: [] };
}

// --------------------------------------------------------------- param UI ---

function buildParamUI() {
  const root = document.getElementById('params');
  root.innerHTML = '';
  for (const g of PARAMS) {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = `<h3>${g.title}</h3>`;
    for (const f of g.fields) div.appendChild(makeField(f));
    root.appendChild(div);
  }
  refreshFieldVisibility();
}

function makeField(f) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.path = f.path;
  const val = get(app.cfg, f.path);

  if (f.type === 'select') {
    wrap.innerHTML = `<div class="row"><label>${f.label}</label></div>
      <select>${f.options.map(([k, l]) => `<option value="${k}"${k === val ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="help"></div>`;
    const sel = wrap.querySelector('select');
    sel.addEventListener('change', () => {
      set(app.cfg, f.path, sel.value);
      rebuild(f.path === 'sim.quality' ? false : true);
      refreshFieldVisibility();
      updateHelp();
    });
  } else {
    const disp = (v) => `${(v * f.scale).toFixed(f.digits)}${f.unit ? ' ' + f.unit : ''}`;
    wrap.innerHTML = `<div class="row"><label>${f.label}</label><span class="val">${disp(val)}</span></div>
      <input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
      <div class="help"></div>`;
    const inp = wrap.querySelector('input');
    const out = wrap.querySelector('.val');
    let pending = null;
    inp.addEventListener('input', () => {
      const v = +inp.value;
      out.textContent = disp(v);
      set(app.cfg, f.path, v);
      clearTimeout(pending);
      pending = setTimeout(() => rebuild(false), 40);
    });
  }
  return wrap;
}

function refreshFieldVisibility() {
  document.querySelectorAll('.field').forEach((el) => {
    const f = PARAMS.flatMap((g) => g.fields).find((x) => x.path === el.dataset.path);
    if (!f) return;
    el.style.display = f.show && !f.show(app.cfg) ? 'none' : '';
  });
  updateHelp();
}

function updateHelp() {
  document.querySelectorAll('.field').forEach((el) => {
    const f = PARAMS.flatMap((g) => g.fields).find((x) => x.path === el.dataset.path);
    const h = el.querySelector('.help');
    if (!f || !h) return;
    h.textContent = f.help ? f.help(app.cfg) : '';
    h.style.display = h.textContent ? '' : 'none';
  });
}

// ---------------------------------------------------------------- tiles ----

function tile(k, v, u, cls = '') {
  return `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}<span class="u">${u}</span></div></div>`;
}

const sig = (v, d = 3) => (isFinite(v) ? Number(v.toPrecision(d)).toLocaleString() : '—');

function renderTiles() {
  const a = app.analysis;
  const tr = app.tr;
  const marginCls = a.liftMargin < 1 ? 'crit' : a.liftMargin < 1.6 ? 'warn' : 'good';
  const statorArea = app.cfg.stator.statorSize ** 2;
  const dT = thermal(a.hoverPower, statorArea);
  const powCls = dT > 60 ? 'crit' : dT > 30 ? 'warn' : '';

  document.getElementById('tiles').innerHTML = [
    tile('Lift margin', sig(a.liftMargin, 3), '× weight', marginCls),
    tile('Platen mass', sig(tr.mass * 1000, 3), 'g'),
    tile('Peak lateral accel', sig(a.maxAccel / 9.80665, 3), 'g'),
    tile('Hover power', a.hoverSaturated > 1e-6 ? '—' : sig(a.hoverPower, 3), 'W', powCls),
    tile('Stator ΔT (est.)', a.hoverSaturated > 1e-6 ? '—' : sig(dT, 2), 'K', powCls),
    tile('Peak gap field', sig(tr.peakGapField, 3), 'T'),
    (() => {
      // Current density is the gate that decides whether a design needs
      // cooling. Because turns x wire-area is fixed by the winding window,
      // lift capability depends only on J -- this is the thermal price of the
      // force, not a footnote.
      const J = (a.hoverPeakCurrent ?? 0) / (app.stator.wireArea * 1e6);
      const cls = J > 20 ? 'crit' : J > 10 ? 'warn' : 'good';
      return tile('Hover current density', sig(J, 2), 'A/mm²', cls);
    })(),
    tile('Condition number', sig(a.conditionNumber, 3), '', a.conditionNumber > 50 ? 'warn' : ''),
    (() => {
      // Channel count is usually what actually stops you building the thing.
      // One H-bridge per coil is the naive wiring; a switching matrix only has
      // to drive the coils under the platen, which is the `active` number.
      const n = app.stator.coils.length;
      const cls = n > 128 ? 'crit' : n > 32 ? 'warn' : 'good';
      return tile('Driver channels', n, `${a.activeCoils} live at once`, cls);
    })(),
  ].join('');
}

function renderSimTiles(peakI, power) {
  const s = app.state;
  const a = app.analysis;
  const err = Math.hypot(
    s.r[0] - (app.lastTarget?.r[0] ?? 0),
    s.r[1] - (app.lastTarget?.r[1] ?? 0),
    s.r[2] - (app.lastTarget?.r[2] ?? app.cfg.sim.gap));
  const satCls = peakI > app.cfg.sim.iMax * 0.98 ? 'crit' : peakI > app.cfg.sim.iMax * 0.8 ? 'warn' : '';
  document.getElementById('simTiles').innerHTML = [
    tile('Air gap', sig(s.r[2] * 1000, 3), 'mm', s.landed ? 'crit' : ''),
    tile('Track error', sig(err * 1e6, 3), 'µm'),
    tile('Speed', sig(Math.hypot(s.v[0], s.v[1], s.v[2]) * 1000, 3), 'mm/s'),
    tile('Peak current', sig(peakI, 3), `/ ${app.cfg.sim.iMax} A`, satCls),
    tile('Copper loss', sig(power, 3), 'W'),
    tile('Lift margin', sig(a.liftMargin, 3), '×'),
  ].join('');
}

// ---------------------------------------------------------------- charts ---

/** Register a canvas with a draw function; hover triggers a redraw with the
 *  pointer position so tooltips work without any retained scene graph. */
function mountChart(id, draw) {
  const cv = document.getElementById(id);
  const entry = { cv, draw, hover: null };
  app.charts.set(id, entry);
  trackHover(cv, (pos) => { entry.hover = pos; entry.draw(entry.hover); });
  return entry;
}

function redraw(id) {
  const e = app.charts.get(id);
  if (e && e.cv.offsetParent !== null) e.draw(e.hover);
}

function redrawAll() {
  renderTiles();
  renderDesignTable();
  for (const id of app.charts.keys()) redraw(id);
  renderSelfTest();
}

const pal = () => theme();

function setupDesignCharts() {
  mountChart('designView', () => {
    render(document.getElementById('designView'), {
      cam: app.camDesign, stator: app.stator, tr: app.tr,
      state: { r: [0, 0, app.cfg.sim.gap], q: quat.identity() },
      currents: app.analysis.hoverCurrents, idxMap: app.analysis.Wm.idx,
    });
  });
  attachOrbit(document.getElementById('designView'), app.camDesign, () => redraw('designView'));

  mountChart('fieldMap', (h) => {
    const comp = document.getElementById('fieldComponent').value;
    const half = app.cfg.translator.platenSize * 0.6;
    const m = fieldMap(app.tr, app.cfg.sim.gap, half, 96, comp);
    heatmap(document.getElementById('fieldMap'), {
      ...m, hover: h, mode: comp === 'bz' ? 'diverging' : 'sequential',
      xLabel: 'x (m)', yLabel: 'y (m)', units: 'T',
      overlays: app.tr.patches.map((p) => ({
        type: 'rect', x0: p.u - p.w / 2, x1: p.u + p.w / 2,
        y0: p.v - p.h / 2, y1: p.v + p.h / 2, color: pal().ink, dashed: true,
      })),
    });
  });
  document.getElementById('fieldComponent').addEventListener('change', () => redraw('fieldMap'));

  mountChart('gapChart', (h) => {
    const gaps = [];
    const gMax = Math.max(app.cfg.sim.gap * 4, app.cfg.translator.pitch * 0.6);
    for (let i = 0; i < 34; i++) gaps.push(0.0003 + (gMax * i) / 33);
    const r = liftVsGap(app.stator, app.tr, app.cfg.sim.iMax, gaps);
    app._gapPower = r.power;
    lineChart(document.getElementById('gapChart'), {
      hover: h, xLabel: 'air gap (mm)', yLabel: 'lift ÷ weight', yZero: true,
      series: [
        { label: 'lift margin', color: pal().s1, pts: r.margin },
        { label: 'unity (hover threshold)', color: pal().critical, dashed: true,
          pts: r.margin.map((p) => [p[0], 1]) },
        { label: 'peak Bz × 10 (T)', color: pal().s3, pts: r.field.map((p) => [p[0], p[1] * 10]) },
      ],
    });
  });

  mountChart('gapPower', (h) => {
    if (!app._gapPower) redraw('gapChart');
    lineChart(document.getElementById('gapPower'), {
      hover: h, xLabel: 'air gap (mm)', yLabel: 'copper loss (W)', yZero: true,
      series: [{ label: 'hover power', color: pal().s2, pts: app._gapPower || [] }],
      title: 'Power to simply stay up',
    });
  });

  mountChart('capMap', (h) => {
    const metric = document.getElementById('mapMetric').value;
    const half = Math.min(app.cfg.stator.statorSize, app.cfg.translator.pitch * 2.5) / 2;
    const m = capabilityMap(app.stator, app.tr, app.cfg.sim.gap, half, 34, app.cfg.sim.iMax, metric);
    const units = { lift: '×w', sigmaMin: 'N/A', power: 'W', cond: '' }[metric];
    heatmap(document.getElementById('capMap'), {
      ...m, hover: h, mode: 'sequential', xLabel: 'platen x (m)', yLabel: 'platen y (m)', units,
    });
  });
  document.getElementById('mapMetric').addEventListener('change', () => redraw('capMap'));

  mountChart('rippleChart', (h) => {
    const span = app.cfg.translator.pitch * 2;
    const r = rippleScan(app.stator, app.tr, app.cfg.sim.gap, span, 60, app.cfg.sim.iMax);
    lineChart(document.getElementById('rippleChart'), {
      hover: h, xLabel: 'platen x (mm)', yZero: true, yLabel: 'A  /  W',
      series: [
        { label: 'peak coil current (A)', color: pal().s1, pts: r.peakI },
        { label: 'copper loss (W)', color: pal().s2, pts: r.power },
      ],
    });
  });

  mountChart('pitchChart', (h) => {
    const cv = document.getElementById('pitchChart');
    if (!app.pitchRows) {
      const { ctx, w } = (() => {
        const c = cv.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: c, w: cv.clientWidth };
      })();
      ctx.fillStyle = pal().surface;
      ctx.fillRect(0, 0, w, cv.clientHeight);
      ctx.fillStyle = pal().muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Press "Run sweep" — this rebuilds the machine ~20 times.', w / 2, cv.clientHeight / 2);
      return;
    }
    lineChart(cv, {
      hover: h, xLabel: 'pole pitch λ (mm)', yLabel: 'lift ÷ weight   ·   g', yZero: true,
      series: [
        { label: 'lift margin (× weight)', color: pal().s1, pts: app.pitchRows.map((r) => [r.pitch, r.margin]) },
        { label: 'lateral accel (g)', color: pal().s2, pts: app.pitchRows.map((r) => [r.pitch, r.accel]) },
        { label: 'unity', color: pal().critical, dashed: true, pts: app.pitchRows.map((r) => [r.pitch, 1]) },
      ],
    });
  });

  document.getElementById('btnPitchSweep').addEventListener('click', () => {
    const lo = 0.010, hi = 0.070;
    const pitches = [];
    for (let i = 0; i < 20; i++) pitches.push(lo + ((hi - lo) * i) / 19);
    app.pitchRows = pitchSweep(app.cfg, pitches, app.cfg.sim.iMax);
    redraw('pitchChart');
    renderDesignTable();
  });
}

function renderDesignTable() {
  const el = document.getElementById('designTable');
  const c = app.cfg, tr = app.tr, st = app.stator, a = app.analysis;
  const nMag = tr.patches.reduce((n, p) =>
    n + Math.round(p.w / (tr.tile.lx / tr.tile.nx)) * Math.round(p.h / (tr.tile.ly / tr.tile.ny)), 0);
  const wireLen = st.coils.reduce((L, k) => L + k.turns * 2 * (k.outer[0] + k.outer[1]), 0);
  const rows = [
    ['Magnet cells on the platen', `${nMag}`, `${(tr.tile.lx / tr.tile.nx * 1000).toFixed(1)} × ${(tr.tile.ly / tr.tile.ny * 1000).toFixed(1)} × ${(c.translator.magnetThickness * 1000).toFixed(1)} mm each`],
    ['Magnet mass', `${sig(tr.magnetMass * 1000, 3)} g`, 'NdFeB at 7500 kg/m³'],
    ['Coils in stator', `${st.coils.length}`, `${st.effTurns} effective turns each, ${sig(st.coils[0]?.R ?? 0, 3)} Ω`],
    ['Total wire length', `${sig(wireLen, 3)} m`, `${sig(st.copperMass * 1000, 3)} g of copper`],
    ['Driver channels needed', `${st.coils.length}`, 'one H-bridge per coil, or a switching matrix'],
    ['Retained field harmonics', `${tr.harm.n}`, `order ≤ ${QUALITY[c.sim.quality].maxOrder}`],
    ...(st.truncated ? [['Stator truncated', 'yes',
      'coil count hit the 48×48 cap — the modelled stator is smaller than the size you set']] : []),
    ['Wrench singular values σ', a.sigma.map((s) => sig(s, 2)).join('  '), 'torque rows normalised by half-platen; last value is σmin'],
  ];
  let html = '<div class="table-wrap"><table><thead><tr><th>Build quantity</th><th>Value</th><th style="text-align:left">Note</th></tr></thead><tbody>';
  for (const [k, v, n] of rows) html += `<tr><td>${k}</td><td>${v}</td><td style="text-align:left;color:var(--muted)">${n}</td></tr>`;
  html += '</tbody></table></div>';

  if (app.pitchRows) {
    html += '<h3 style="font-size:12px;margin:16px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Pole-pitch sweep results</h3><div class="table-wrap"><table><thead><tr><th>λ (mm)</th><th>lift ÷ w</th><th>accel (g)</th><th>hover P (W)</th><th>σmin</th><th>cond</th><th>mass (g)</th><th>peak B (T)</th></tr></thead><tbody>';
    for (const r of app.pitchRows) {
      html += `<tr><td>${r.pitch.toFixed(1)}</td><td>${sig(r.margin, 3)}</td><td>${sig(r.accel, 3)}</td><td>${sig(r.power, 3)}</td><td>${sig(r.sigmaMin, 3)}</td><td>${sig(r.cond, 3)}</td><td>${sig(r.mass * 1000, 3)}</td><td>${sig(r.peakB, 3)}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

function renderSelfTest() {
  const t = selfTest();
  document.getElementById('selfTest').innerHTML =
    `<strong>Model check.</strong> Fundamental of a 4-segment 1-D Halbach:<br>
     model ${t.model.toFixed(4)} T vs closed form ${t.analytic.toFixed(4)} T
     (${(t.relError * 100).toFixed(2)}% <span class="${t.pass ? 'ok' : 'bad'}">${t.pass ? 'PASS' : 'FAIL'}</span>)`;
}

// ------------------------------------------------------------ simulation ---

function setupSimCharts() {
  mountChart('simView', () => {
    render(document.getElementById('simView'), {
      cam: app.camSim, stator: app.stator, tr: app.tr, state: app.state,
      currents: app.lastCurrents, idxMap: app.lastIdx,
      target: app.lastTarget?.r, trail: app.hist.trail,
    });
  });
  attachOrbit(document.getElementById('simView'), app.camSim, () => redraw('simView'));

  mountChart('currentStrip', (h) => {
    barStrip(document.getElementById('currentStrip'), app.lastCurrents ?? [], {
      hover: h, labels: (i) => {
        const c = app.stator.coils[app.lastIdx?.[i] ?? 0];
        return c ? `coil at (${(c.x * 1000).toFixed(0)}, ${(c.y * 1000).toFixed(0)}) mm` : `coil ${i}`;
      },
    });
  });

  const scope = (id, keys, labels, colors, yLabel) => mountChart(id, (h) => {
    const H = app.hist;
    lineChart(document.getElementById(id), {
      hover: h, xLabel: 't (s)', yLabel,
      series: keys.map((k, i) => ({
        label: labels[i], color: colors[i], pts: H.t.map((t, j) => [t, H[k][j]]),
      })),
    });
  });
  const p = pal();
  scope('scopePos', ['ex', 'ey', 'ez'], ['x', 'y', 'z'], [p.s1, p.s2, p.s3], 'error (µm)');
  scope('scopeAtt', ['ax', 'ay', 'az'], ['roll', 'pitch', 'yaw'], [p.s1, p.s2, p.s3], 'error (mrad)');
  scope('scopeCur', ['ip'], ['peak |i|'], [p.s1], 'A');
  scope('scopePow', ['pw'], ['copper loss'], [p.s2], 'W');
}

function simulate(frameDt) {
  const q = QUALITY[app.cfg.sim.quality];
  const dt = 1 / q.controlHz;
  const nSteps = clamp(Math.round(frameDt / dt), 1, 60);
  const tp = { ...app.trajParams, gap: app.cfg.sim.gap };
  let peakI = 0, power = 0;

  for (let s = 0; s < nSteps; s++) {
    const target = TRAJECTORIES[app.traj].at(app.state.t, tp);
    app.lastTarget = target;
    const { w, ep, ea } = control(app.ctrl, app.state, app.tr, dt, target);
    const Wm = buildWrench(app.stator, app.tr, app.state.r, app.state.q);
    // Levitation first, manoeuvring with whatever headroom is left.
    const wLift = [0, 0, app.tr.mass * 9.80665, 0, 0, 0];
    const alloc = allocatePrioritised(Wm, wLift,
      w.map((v, i) => v - wLift[i]), app.cfg.sim.iMax);
    app.ctrl.sat = alloc.saturated; // feeds the controller's anti-windup
    const wrench = applyDisturbance(app.dist, alloc.achieved, dt, app.tr);
    step(app.state, app.tr, wrench, dt);

    app.lastCurrents = alloc.i;
    app.lastIdx = Wm.idx;
    peakI = 0;
    for (let j = 0; j < alloc.i.length; j++) peakI = Math.max(peakI, Math.abs(alloc.i[j]));
    power = copperLoss(app.stator, Wm, alloc.i);

    // Sample the scopes at a fixed rate rather than every control step.
    if (s === nSteps - 1) {
      const H = app.hist;
      H.t.push(app.state.t);
      H.ex.push(ep[0] * 1e6); H.ey.push(ep[1] * 1e6); H.ez.push(ep[2] * 1e6);
      H.ax.push(ea[0] * 1e3); H.ay.push(ea[1] * 1e3); H.az.push(ea[2] * 1e3);
      H.ip.push(peakI); H.pw.push(power);
      H.trail.push([app.state.r[0], app.state.r[1], app.state.r[2]]);
      const cap = 420;
      for (const k of ['t', 'ex', 'ey', 'ez', 'ax', 'ay', 'az', 'ip', 'pw']) {
        if (H[k].length > cap) H[k].shift();
      }
      if (H.trail.length > 600) H.trail.shift();
    }

    // Runaway guard: if the loop diverges, stop rather than render NaNs.
    if (!isFinite(app.state.r[0]) || Math.hypot(app.state.r[0], app.state.r[1]) > 5) {
      resetSimulation();
      app.running = false;
      document.getElementById('btnPlay').textContent = 'Play';
      break;
    }
  }
  app.lastPeakI = peakI;
  app.lastPower = power;
}

function frame(ts) {
  const dt = app.lastFrame ? Math.min((ts - app.lastFrame) / 1000, 0.05) : 0.016;
  app.lastFrame = ts;

  if (app.tab === 'simulate') {
    if (app.running) simulate(dt);
    redraw('simView');
    redraw('currentStrip');
    redraw('scopePos'); redraw('scopeAtt'); redraw('scopeCur'); redraw('scopePow');
    renderSimTiles(app.lastPeakI ?? 0, app.lastPower ?? 0);
    const st = document.getElementById('simStatus');
    const sat = (app.lastPeakI ?? 0) >= app.cfg.sim.iMax * 0.995;
    st.textContent = app.state.landed
      ? 'CRASHED — platen is resting on the stator. Lower the mass, raise the current limit, or shorten the pole pitch.'
      : sat ? 'Current limited — the allocator is scaling the commanded wrench back.'
        : `t = ${app.state.t.toFixed(2)} s · ${QUALITY[app.cfg.sim.quality].controlHz} Hz control`;
    st.className = 'status' + (app.state.landed || sat ? ' crit' : '');
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------- wire ---

function setupChrome() {
  const presetSel = document.getElementById('presetSelect');
  presetSel.innerHTML = Object.entries(PRESETS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  presetSel.value = app.presetKey;
  presetSel.addEventListener('change', () => {
    app.camDesign.userZoomed = app.camSim.userZoomed = false;
    loadPreset(presetSel.value);
    renderAbout();
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    app.camDesign.userZoomed = app.camSim.userZoomed = false;
    loadPreset(app.presetKey);
  });

  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    app.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `pane-${app.tab}`));
    if (app.tab === 'design') redrawAll();
  });

  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur ? cur === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    setupSimCharts(); // scope colours are baked in at mount time
    redrawAll();
  });

  const trajSel = document.getElementById('trajSelect');
  trajSel.innerHTML = Object.entries(TRAJECTORIES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  trajSel.addEventListener('change', () => { app.traj = trajSel.value; });

  const bind = (id, outId, fmt, apply) => {
    const el = document.getElementById(id), out = document.getElementById(outId);
    const upd = () => { out.textContent = fmt(+el.value); apply(+el.value); };
    el.addEventListener('input', upd); upd();
  };
  bind('trajSpeed', 'trajSpeedOut', (v) => `${v.toFixed(1)}`, (v) => { app.trajParams.speed = v; });
  bind('trajAmp', 'trajAmpOut', (v) => `${v} mm`, (v) => { app.trajParams.amplitude = v / 1000; });
  bind('noiseSlider', 'noiseOut', (v) => `${(v * 100).toFixed(1)}%`, (v) => { app.dist.noise = v; });

  document.getElementById('btnPlay').addEventListener('click', (e) => {
    app.running = !app.running;
    e.target.textContent = app.running ? 'Pause' : 'Play';
  });
  document.getElementById('btnResetSim').addEventListener('click', resetSimulation);
  document.getElementById('btnKick').addEventListener('click', () => kick(app.dist, app.tr, 0.6, 25));

  window.addEventListener('resize', () => { if (app.tab === 'design') redrawAll(); });
}

function renderAbout() {
  document.getElementById('aboutBody').innerHTML = `
    <h2>What this simulates</h2>
    <p>A moving-magnet planar motor: a Halbach permanent-magnet platen flying above a
    stationary array of ironless coils. There is no iron anywhere in the model, which is
    what makes a closed-form treatment legitimate — the magnets and the coils interact
    only through free space.</p>

    <h2>The model, in one paragraph</h2>
    <p>The platen magnetisation is expanded as a 2-D Fourier series over one spatial
    period. Each harmonic's air-gap field decays as <code>exp(−k·d)</code>, and the
    one-sided (Halbach) flux condition falls out of the algebra rather than being assumed.
    Force and torque on the platen come from Lorentz integration of <code>I·dl × B</code>
    over every coil filament, negated by Newton's third law. Because that is linear in
    current, the whole machine collapses to a 6×N <em>wrench matrix</em>
    <code>W</code>: commutation is <code>i = W⁺w</code>, force capability is the singular
    values of <code>W</code>, and dead spots are poses where σ<sub>min</sub> collapses.</p>

    <h2>Where the model is approximate</h2>
    <ul>
      <li><strong>Finite array edges</strong> are handled with a half-pitch smooth taper on
      the periodic field. Errors are largest within about one pole pitch of an array edge.
      A truly finite array needs a surface-charge model.</li>
      <li><strong>No eddy currents, no iron, no back-EMF-limited drivers.</strong> The
      current source is ideal. Real drivers run out of voltage at speed.</li>
      <li><strong>Thermal estimate is crude</strong> — a fixed natural-convection
      coefficient over the stator footprint. It exists to flag designs that will obviously
      melt, not to size a heatsink.</li>
      <li><strong>Magnet μ<sub>r</sub> = 1.</strong> Real NdFeB is ≈1.05.</li>
      <li>The <strong>model check</strong> in the sidebar compares the computed fundamental
      against the textbook closed form for a discrete Halbach array. If it says FAIL, don't
      trust anything else on screen.</li>
    </ul>

    <h2>Reading the design tab</h2>
    <ul>
      <li><strong>Lift margin</strong> below 1 means it physically cannot hover. Aim for 2–3×
      so there is authority left for acceleration and disturbance rejection.</li>
      <li><strong>Lift vs air gap</strong> is the plot that kills most first designs. Flying
      height is set by pole pitch, full stop.</li>
      <li><strong>Capability map</strong> shows whether the machine is uniform across the
      stator. Periodic dark patches mean the commutation loses a degree of freedom at
      certain positions — usually a coil-pitch / pole-pitch ratio problem.</li>
      <li><strong>Condition number</strong> above ~50 means some wrench direction is much
      more expensive than others; the controller will feel sloppy in that axis.</li>
    </ul>

    <h2>Current preset</h2>
    <p>${PRESETS[app.presetKey].blurb}</p>

    <h2>Source literature</h2>
    <ul>
      <li>W.-J. Kim, <em>High-Precision Planar Magnetic Levitation</em>, PhD thesis, MIT, 1997 —
      <a href="https://dspace.mit.edu/handle/1721.1/10419" target="_blank" rel="noopener">dspace.mit.edu</a>.
      The origin of the field; four Halbach linear levitation motors under one platen.</li>
      <li>J. W. Jansen, <em>Magnetically Levitated Planar Actuator with Moving Magnets</em>,
      PhD thesis, TU Eindhoven, 2007 —
      <a href="https://pure.tue.nl/ws/files/2471953/200711951.pdf" target="_blank" rel="noopener">pure.tue.nl (PDF)</a>.
      The harmonic force/torque model this simulator implements, plus commutation.</li>
      <li>H. Zhu, T. J. Teo, C. K. Pang, <em>Design and Modeling of a Six-Degree-of-Freedom
      Magnetically Levitated Positioner Using Square Coils and 1-D Halbach Arrays</em>,
      IEEE Trans. Industrial Electronics 64(1):440&ndash;450, 2017 —
      <a href="https://danielteodesigntechnology.wordpress.com/wp-content/uploads/2011/06/maglev_square_coils_tie2016.pdf" target="_blank" rel="noopener">PDF</a>.
      The most buildable topology.</li>
      <li><em>Force and Torque Model of a Magnetically Levitated System with 2D Halbach
      Array and PCB Coils</em>, Sensors 23(21), 2023 —
      <a href="https://www.mdpi.com/1424-8220/23/21/8735" target="_blank" rel="noopener">open access</a>.
      Tileable 16-layer PCB stator.</li>
      <li><em>FleXstage</em>, arXiv 2309.11735 —
      <a href="https://arxiv.org/pdf/2309.11735" target="_blank" rel="noopener">PDF</a>.
      Over-actuated lightweight platen.</li>
      <li>R. Chen, <em>A New Type of Magnet Array for Planar Motor</em>, MSc, UBC —
      <a href="https://open.library.ubc.ca/media/stream/pdf/24/1.0340572/3" target="_blank" rel="noopener">PDF</a>.
      Array topologies with gaps and staggers.</li>
    </ul>`;
}

// ------------------------------------------------------------------- boot ---

setupChrome();
loadPreset('pcb');
setupDesignCharts();
setupSimCharts();
renderAbout();
redrawAll();
requestAnimationFrame(frame);
