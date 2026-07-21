# Planar Maglev Motor Simulator

A browser-based design explorer and 6-DOF flight simulator for **moving-magnet
planar motors**: a Halbach permanent-magnet platen levitating over a stationary
array of ironless coils.

No build step, no dependencies. Serve the directory and open `index.html`:

```sh
python3 -m http.server 8000     # then http://localhost:8000
```

Tests (Node 18+, no dependencies):

```sh
cd test && node physics.test.mjs && node flight.test.mjs && node optimise.test.mjs
```

---

## What it models

The whole machine reduces to one object: a **6×N wrench matrix** `W`.

```
[Fx Fy Fz Tx Ty Tz]ᵀ  =  W(pose) · i
```

Column *j* is the force and torque produced by one ampere in coil *j*. Because
that relationship is exactly linear, everything else falls out of it:

| Question | Answer |
|---|---|
| What currents do I command? | `i = W⁺w` — damped least-norm commutation |
| How much force can it make? | singular values of `W` |
| Are there dead spots? | poses where σ<sub>min</sub>(`W`) collapses |
| How hot does it get? | `Σ iⱼ²Rⱼ` |
| Will it fly? | integrate a rigid body driven by `W·i` |
| How few amplifiers can I get away with? | `W_eff = W·G` for a grouping `G` |
| What should I actually build? | constrained search over the coupled design space |

### The field model

The platen magnetisation is expanded as a 2-D Fourier series over one spatial
period. For each harmonic with in-plane wavevector **k**, the field below a slab
of thickness *D* is

```
Bz(k) = ½(1 − e^(−kD)) · [ M̂z − i(kx·M̂x + ky·M̂y)/k ] · e^(−kd)
Bx(k) = i(kx/k)·Bz(k)        By(k) = i(ky/k)·Bz(k)
```

with magnetisation in tesla (`|m| = Br`). The bracket **vanishes for the
wrong-handed harmonic** — the Halbach one-sided-flux condition is a consequence
of the algebra, not an assumption. `orientStrongSideDown()` measures which face
the flux exits and flips the array if needed, so new patterns can't be silently
built upside-down.

The exact Fourier coefficient of the piecewise-constant magnet cells carries a
sinc factor, which is where the classic discrete-Halbach amplitude penalty
`sin(π/M)/(π/M)` comes from — it is derived, not hardcoded.

Force and torque come from Lorentz integration of `I·dl × B` over every coil
filament, negated by Newton's third law.

### Phase grouping

Real machines do not give every coil its own current source. Coils are wired or
switched into a few phase groups and commutated against the magnet phase —
Zhu/Teo/Pang drive ~120 live coils from **eight** amplifiers. Model it as a
linear map `i = G·u` from phase currents to coil currents, and the wrench matrix
simply composes:

```
w = W·i = (W·G)·u
```

so allocation, singular values and dead-spot maps all work on `W_eff` unchanged
(`test/physics.test.mjs` checks `W_eff = W·G` is exact to 4e-16). `G` holds
sinusoidal commutation weights over spatial regions that subdivide each magnet
array and follow the platen — the physically realisable kind. What it costs:

| Preset | Drive | Amplifiers | Cond. | 6-DOF? | Hover | Tracking |
|---|---|---|---|---|---|---|
| PCB | independent | 144 | 2.6 | yes | 7.5 W | 42 µm |
| PCB | 2×2 per array | **16** | 5.6 | yes | 11.4 W | 42 µm |
| Wound (cross) | independent | 121 | 2.5 | yes | 38.6 W | 66 µm |
| Wound (cross) | 1 per array | **8** | 3.0 | yes | 72.8 W | 66 µm |
| Racetrack | independent | 108 | 6.2 | yes | 38.6 W | 206 µm |
| Racetrack | 3×3 per array | 36 | 20.4 | yes | 60.4 W | *worst-case lift 0.98×* |

The headline: **8 amplifiers track exactly as well as 121** on the four-array
cross, at roughly double the hover power. That is the published design, and the
model reproduces it. The racetrack is the exception — see limitations below.

### Reading the machine view

Every part is drawn as an extruded solid with its real thickness — magnet
stack, winding build height, backing plate — because those thicknesses *are*
the design. Two viewing aids, both of which distort the picture deliberately
and label themselves on the canvas when active:

- **Section cut** along x or y, with a draggable plane. Hides everything past
  the cut so you can see the layer stack and the air gap in cross-section.
- **Vertical exaggeration** (z×1–12). A 1.5 mm air gap under a 72 mm platen is
  otherwise a sub-pixel sliver.

The air gap carries a live dimension callout, since it is the variable
everything else trades against. The backing plate is drawn translucent so the
magnet array stays visible at true scale.

### Design search

A 1-D sweep answers "what is the best pole pitch, holding everything else
fixed?" — the wrong question, because the optimum pitch depends on the air gap,
which depends on the winding height, which trades against turn count. The
**Optimise** tab searches them together: random sampling to find the basins, then
pattern search from the best candidates. ~330 designs/second, so a 500-design
search takes under two seconds and runs in animation frames without blocking.

Designs are **constrained, then ranked** — never a weighted sum of objectives. A
weighted sum silently trades a hard physical requirement for a soft one, and no
amount of low hover power compensates for a machine that cannot lift itself
somewhere in its workspace. Hard gates: worst-case lift, stator ΔT, current
density, amplifier count, full rank-6 controllability, and a buildable air-gap
floor. Then one objective (max acceleration, min power, max lift-per-watt, …).

Any result can be pushed back into the live config — from the best-design card,
a table row, or by clicking a point in the design-space scatter. Applying
**re-verifies at full solver quality**, since the search runs coarse; the two
agree to ~3%.

**Pin what you already know.** With ten coupled variables you usually know
several of them from the application — the platen has to be 120 mm, the gap has
to clear a 2 mm contamination budget — and want the budget spent on the rest.
Untick a dimension and it is held at the value shown, editable right there
(edits flow straight into the live design). Ticked dimensions get an editable
min/max, so you can also just narrow a range rather than pin it outright. The
panel reports how many of the variables are actually being searched.

Three things the search does that a sweep cannot:

- **Reports which bounds are binding.** If the winner sits on a search bound,
  the bound chose the value, not the physics, and it says so.
- **Reports why nothing was feasible.** A ranked histogram of which constraint
  blocked how many candidates — the top row is the one to loosen.
- **Shows the Pareto front**, so you can see the trade rather than just the
  single point that happened to win the objective you picked.

It also validates itself: given free rein over the coil-pitch ratio, the search
independently converges on **λ/3** — the three-phase spacing the literature
prescribes, and which this simulator earlier had to discover the hard way.

Run against the PCB preset it found, in ~350 designs, a machine strictly better
on every axis than the hand-tuned starting point:

| | hand-tuned | searched |
|---|---|---|
| Lift margin | 4.73× | **9.37×** |
| Lateral accel | 4.96 g | **6.8 g** |
| Hover power | 11.4 W | **4.71 W** |
| Stator ΔT | 51 K | **9.5 K** |
| Amplifiers | 16 | 16 |

### Validation

`test/physics.test.mjs` checks the model against independent ground truth:

- fundamental amplitude vs the closed form `Br(1−e^(−kD))·sin(π/M)/(π/M)`, for
  M = 2, 3, 4, 6, 8 — **exact to 0.00%**
- wrong-handed array's flux suppressed to 5×10⁻¹⁷ T
- field decay constant equals `2π/λ` to 1 part in 10⁶
- **lift capability of the assembled machine falls off at the harmonic decay
  rate** `k = 2π√2/λ` — an end-to-end check through geometry, Fourier
  decomposition, Lorentz integration and the allocator
- allocation linearity, pure-lift orthogonality, rank-6 controllability

The same fundamental check runs live in the sidebar. **If it says FAIL, nothing
else on screen is trustworthy.**

`test/flight.test.mjs` flies every preset through hover, circle and raster
trajectories and asserts it stays airborne and settles.

---

## Things the simulator taught us

These were found *by* the tool during development, and are the kind of thing it
exists to surface:

- **Coil pitch = λ/2 is a trap.** The coil grid lands exactly in phase with the
  magnet array and lateral force cancels *identically* at symmetric poses — a
  50× collapse in thrust while lift looks perfect. This is why three-phase
  designs use λ/3. The capability map shows it immediately.
- **Full-width racetrack coils cannot control yaw.** Force is uniform along each
  coil's length, so no current distribution produces T<sub>z</sub> and `W` drops
  to rank 5. Real racetrack stators are built as blocks of finite-length coils
  for exactly this reason.
- **There is an optimum pole pitch.** Run the pole-pitch sweep: lift margin
  peaks and hover power bottoms out at a specific λ for a given air gap. Too
  fine and the field never reaches the coils; too coarse and you waste magnet.
- **Saturation must prioritise levitation.** Scaling the whole commanded wrench
  back when the drivers run out throttles lift too, and the platen falls.
  `allocatePrioritised()` solves lift first and spends the remaining headroom on
  manoeuvring.
- **Turn count is not a free parameter.** Coil turns are derived from
  `(window area × 0.7) / wire area`. Allowing a turn count to be typed in
  produced a "12 mm" coil that would physically stand 96 mm tall and reported a
  lift margin it could never deliver — 56 kg of copper in a stator meant to lift
  1.7 kg.
- **Lift capability depends only on current density, not wire gauge.** Since
  turns × wire-area is fixed by the window, `lift ∝ N·I ∝ J`. Choosing thicker
  wire buys nothing but fewer turns. This is why the current-density tile, not
  the ampere limit, is the number that decides whether a design needs cooling.
- **Segmented racetrack coils need staggering.** Un-staggered, every coil in a
  column ends at the same y, so the platen periodically straddles a seam where
  only perpendicular end-turns sit beneath it. Lift collapsed to **0.16×
  weight** in bands a few mm wide — the platen fell straight through them.
  Staggering alternate columns by half a segment took worst-case lift from 0.16×
  to 1.44×.
- **Grouping is nearly free on the right layout, and impossible on the wrong
  one.** Eight amplifiers match 121 on the four-array cross; the racetrack loses
  so much capability that worst-case lift falls below 1× weight. Which topology
  you pick determines whether you need 8 drivers or 108.
- **A radial four-array cross has no yaw authority at all.** Each array at
  position `r` thrusting along `r` contributes `r × F = 0`. The arrays must
  thrust *tangentially*. This bug was invisible under per-coil control (single
  coils can still make yaw) and only surfaced once array-level grouping forced
  the layout's structure to matter — fixing it also improved independent-drive
  conditioning from 5.1 to 2.5.
- **Never judge a stator at its centred pose.** That pose is a symmetry point.
  `flight.test.mjs` now sweeps a ±30 mm workspace and demands the design hover
  *everywhere*; the racetrack dead bands were invisible to a centred check.

## Layout

```
index.html          Design (static analysis), Optimise (search), Simulate (flight)
src/math.js         vectors, quaternions, Cholesky, Jacobi eigenvalues
src/halbach.js      magnet tiles, Fourier decomposition, air-gap field
src/coils.js        stator topologies reduced to current filaments
src/physics.js      wrench matrix, allocation, rigid-body dynamics
src/control.js      6-DOF PID with gravity + acceleration feedforward, trajectories
src/analysis.js     design sweeps (gap, pole pitch, capability maps, ripple)
src/grouping.js     phase grouping: commutating many coils from few amplifiers
src/optimise.js     constrained multi-dimensional design search
src/render3d.js     dependency-free solid-geometry 3-D canvas renderer
src/plots.js        line charts, heatmaps, bar strips with hover readouts
src/app.js          parameter UI, presets, the frame loop
```

## Known approximations

- **Finite array edges** use a half-pitch smooth taper on the periodic field.
  Errors are largest within about one pole pitch of an array edge; a truly
  finite array needs a surface-charge model.
- **No eddy currents, no iron, no back-EMF limit.** The current source is ideal;
  real drivers run out of voltage at speed.
- **Thermal estimate is crude** — a fixed natural-convection coefficient over
  the stator footprint. It flags designs that will obviously melt; it does not
  size a heatsink.
- **Magnet μ<sub>r</sub> = 1** (real NdFeB ≈ 1.05).
- **Winding packing is a flat 0.7**, reasonable for layer winding, optimistic
  for a hand-wound scramble winding (~0.5).
- **Commutation weights are sampled at each coil's centre.** Accurate for
  compact coils (square, PCB spiral), poor for long racetracks whose two long
  sides span a wide range of magnet phase. Some of the racetrack's poor
  behaviour under grouping is this approximation rather than the topology.
- **The search optimises the model, not reality.** Every approximation above is
  inherited, and an optimiser is extremely good at finding whichever corner of
  the model is least faithful. Treat a searched design as a hypothesis to check,
  not an answer — and read the active-bounds warning first.
- **No driver electrical model.** Amplifier count is reported, but voltage
  limits, back-EMF and the switching matrix itself are not simulated.
- The wrench matrix is rebuilt at the control rate, not every dynamics substep.

## Source literature

- W.-J. Kim, *High-Precision Planar Magnetic Levitation*, PhD thesis, MIT, 1997 —
  [dspace.mit.edu](https://dspace.mit.edu/handle/1721.1/10419). Where the field
  started: four Halbach linear levitation motors under one 5 kg platen.
- J. W. Jansen, *Magnetically Levitated Planar Actuator with Moving Magnets*,
  PhD thesis, TU Eindhoven, 2007 —
  [PDF](https://pure.tue.nl/ws/files/2471953/200711951.pdf). The harmonic
  force/torque model implemented here, plus commutation and decoupling.
- H. Zhu, T. J. Teo, C. K. Pang, *Design and Modeling of a Six-Degree-of-Freedom
  Magnetically Levitated Positioner Using Square Coils and 1-D Halbach Arrays*,
  IEEE Trans. Industrial Electronics 64(1):440–450, 2017 —
  [PDF](https://danielteodesigntechnology.wordpress.com/wp-content/uploads/2011/06/maglev_square_coils_tie2016.pdf).
  The most buildable topology.
- *Force and Torque Model of a Magnetically Levitated System with 2D Halbach
  Array and PCB Coils*, Sensors 23(21), 2023 —
  [open access](https://www.mdpi.com/1424-8220/23/21/8735). Tileable 16-layer
  PCB stator.
- *FleXstage*, arXiv 2309.11735 — [PDF](https://arxiv.org/pdf/2309.11735).
  Over-actuated lightweight platen.
- R. Chen, *A New Type of Magnet Array for Planar Motor*, MSc, UBC —
  [PDF](https://open.library.ubc.ca/media/stream/pdf/24/1.0340572/3). Array
  topologies with gaps and staggers.

Commercially this is [Planar Motor Inc.](https://planarmotor.com/) (UBC spinout)
and Beckhoff XPlanar — both moving-magnet 2-D Halbach over coil tiles.
