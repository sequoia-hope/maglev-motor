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
cd test && node physics.test.mjs && node flight.test.mjs
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
- **Never judge a stator at its centred pose.** That pose is a symmetry point.
  `flight.test.mjs` now sweeps a ±30 mm workspace and demands the design hover
  *everywhere*; the racetrack dead bands were invisible to a centred check.

## Layout

```
index.html          two tabs: Design (static analysis) and Simulate (live flight)
src/math.js         vectors, quaternions, Cholesky, Jacobi eigenvalues
src/halbach.js      magnet tiles, Fourier decomposition, air-gap field
src/coils.js        stator topologies reduced to current filaments
src/physics.js      wrench matrix, allocation, rigid-body dynamics
src/control.js      6-DOF PID with gravity + acceleration feedforward, trajectories
src/analysis.js     design sweeps (gap, pole pitch, capability maps, ripple)
src/render3d.js     dependency-free 3-D canvas renderer
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
- **No driver model, and no phase grouping.** The allocator gives every coil an
  independent current, because that maximises controllability and keeps `W`
  clean. Real machines exploit the platen's symmetry to commutate coils in
  groups: Zhu/Teo/Pang drive roughly 60 coils from **eight** amplifiers. So the
  channel count reported here is an *upper bound on drive complexity for
  independent control*, not a property of the topology — a grouped design of the
  same geometry could need an order of magnitude fewer amplifiers, at some cost
  in controllability. Voltage limits and back-EMF are not modelled at all.
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
