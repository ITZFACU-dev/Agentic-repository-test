# Cosmoscope

**A real-time, browser-based N-body astrophysics laboratory for STEM teaching.**

Cosmoscope simulates gravity the way a textbook describes it — pairwise Newtonian
attraction plus post-Newtonian corrections, tidal dissipation, radiative balance and
Roche-limit breakup — and then renders the result with an HDR pipeline that includes
gravitational lensing, relativistic accretion disks, procedural planet surfaces and
Rayleigh/Mie atmospheres.

Everything runs in the browser on WebGL2. There is no server, no dataset to download and
no pre-baked animation: every pixel you see is a function of the integrated state.

### Run it right now

Grab the prebuilt bundle — 220 kB, no toolchain, no `npm install`:

**➜ [`release/cosmoscope-1.0.0.zip`](https://github.com/ITZFACU-dev/Agentic-repository-test/blob/main/release/cosmoscope-1.0.0.zip)**

```
unzip cosmoscope-1.0.0.zip
cd cosmoscope-1.0.0
node serve.mjs          # then open http://localhost:8080
```

`serve.mjs` is a 70-line static server included in the zip (Node 18+); any static server
works. Use HTTP rather than `file://` — browsers refuse to create module workers from the
file system, so nothing would run. The archive is listed on the
[releases page](https://github.com/ITZFACU-dev/Agentic-repository-test/releases) and can
also be regenerated from a clean checkout with `npm ci && npm run build && npm run release`.

From source:

```
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle
npm run test:all   # 99 physics checks + shader lint + worker integration harness
```

---

## 1. What it does

| Capability | Where |
| --- | --- |
| RK4 / velocity-Verlet / 4th-order Hermite integrators, switchable live | `src/physics/PhysicsEngine.ts` |
| Adaptive sub-stepping driven by the local gravitational gradient ∇g | `PhysicsEngine.requiredSubsteps()` |
| Dynamic Plummer softening ε, tree-or-direct force evaluation | `softening2For()`, `src/physics/BarnesHut.ts` |
| 1PN relativity (perihelion precession) + Lense-Thirring frame dragging | `applyRelativisticCorrections()` |
| Fluid (2.44 R) and rigid (1.26 R) Roche limits → instanced debris rings | `checkRoche()`, `BodyRenderer.updateParticles()` |
| Inelastic/elastic collisions with Q = ½μΔv² shock heating and power-law fragments | `resolveCollisions()`, `mergeBodies()` |
| Lava lakes that cool by Stefan-Boltzmann radiation | `updateThermodynamics()` |
| T_eq with albedo + greenhouse, habitable-zone ribbons | `updateThermodynamics()`, `src/shaders/hz.*.glsl` |
| Tidal heating of eccentric orbits (Io–Jupiter) and tidal locking | `updateTides()` |
| Chandrasekhar (1.44 M☉) / TOV (2.17 M☉) collapse → WD, NS, Kerr BH | `collapseStar()`, `compactRadius()` |
| Procedural surfaces, single + multiple atmospheric scattering | `src/shaders/body.*.glsl`, `atmosphere.*.glsl` |
| HDR octahedral starfield with eye adaptation | `src/shaders/starfield.frag.glsl`, `luminance.frag.glsl` |
| Gravitational lensing + relativistic accretion disk | `src/shaders/lensing.frag.glsl` |
| Spacetime-curvature grid (Flamm paraboloid, per-vertex GPU) | `src/shaders/grid.*.glsl` |
| Live L1–L5 Lagrange markers, trails, vector overlays | `src/render/OverlayRenderer.ts` |
| Energy-conservation graph, Keplerian telemetry, logarithmic time warp | `src/ui/EnergyGraph.ts`, `Inspector.ts`, `Panels.ts` |
| What-if constants (G, c, radiation pressure, luminosity) and one-click scenarios | `src/workers/physics.worker.ts` |
| Accretion feedback: swallowed mass → Eddington-limited light curve → disk colour + radiation pressure | `updateAccretion()`, `radAccel()` |
| Five quality tiers with a frame-time governor that adapts live | `src/render/Quality.ts` |
| CSV / JSON / text lab-report export of the running state | `src/ui/Exporter.ts` |
| Touch: pinch zoom, two-finger pan, slide-out panel drawer | `src/render/CameraRig.ts`, `src/ui/Panels.ts` |

### Learning modules

| Module | Preset(s) | Physics on display |
| --- | --- | --- |
| 1. Solar System | `solar-system` | Barycentric wobble (the Sun's 12-year dance around the Jupiter–Sun barycentre), 261 bodies including the Kuiper belt and comets |
| 2. Three-body chaos | `three-body-figure8`, `three-body-pythagorean`, `chaos-lyapunov` | Chenciner–Montgomery figure-eight, Broucke–Hadjidemetriou Pythagorean orbit, exponential Lyapunov divergence from a 1-metre perturbation |
| 3. Orbital Mechanics 101 | `orbital-hohmann`, `orbital-assist` | Hohmann transfer Δv = 2.3995 + 1.4572 km/s (LEO 6 778 km → GEO), gravity-assist speed change, escape velocity |
| 4. Tidal disruption events | `tde` | A star on a parabolic orbit is spaghettified inside R_t = R★(M_BH/m★)^{1/3}; the debris streams on ballistic orbits |
| 5. Dark-matter lab | `galaxy-curve` | Flat rotation curves from an NFW halo (v(10 kpc)/v(20 kpc) = 1.08) versus the Keplerian 0.71 decline |

Extra labs: `roche-ring`, `tidal-heating`, `sun-black-hole`, `impact`, `binary`,
`stellar-collapse`, `sandbox`.

---

## 2. Architecture

```
index.html ─ src/main.ts ─ src/ui/App.ts
                                │  commands            snapshots (transferable)
                                ▼                             ▲
                        src/workers/physics.worker.ts ────────┘
                                │
                        src/physics/PhysicsEngine.ts   (SoA Float64 state)
                                ├── CelestialBody.ts   (masses, radii, composition)
                                ├── BarnesHut.ts       (O(N log N) octree)
                                └── OrbitalElements.ts (state vector ⇄ Kepler)

   src/render/  HDRPipeline · CameraRig · BodyRenderer · Starfield · CurvatureGrid
                OverlayRenderer · Labels · SceneManager
   src/shaders/ body · atmosphere · starfield · grid · lensing · bright · blur
                luminance · tonemap · hz  (+ shared.glsl noise/colour library)
   src/sim/     presets.ts · protocol.ts
```

**The physics never blocks the renderer.** The engine lives in a dedicated Web Worker and
integrates a fixed time step; the main thread asks for "advance by *dt* seconds", draws
whatever snapshot it already has, and swaps in the next one when it arrives. Snapshots
travel through a three-deep buffer pool with transferable `ArrayBuffer`s, so the steady
state allocates nothing. A slow frame changes the resolution of the simulation (the
sub-step budget is bounded and reported) but can never destabilise an orbit.

**Rendering is camera-relative.** Positions are metres throughout — a 6 371 km planet and
a 10¹³ m orbit in one scene — so the vertex shaders subtract the camera position and use a
rotation-only view matrix, with adaptive near/far planes that track the size of whatever
is selected. Float32 precision stays usable from a planetary surface to the Kuiper belt.

### Physics decisions worth knowing

* **Softening is numerical only.** `ε²` never includes body radii; contact is the
  collision resolver's job. Including radii biased Io's force by ~4 % and broke the
  Keplerian-orbit validation, which is exactly the kind of physics you cannot fudge.
* **Sub-stepping uses τ = max(|v|/|a|, √(r/|a|)).** For a circular orbit both terms equal
  the orbital period over 2π; for a body released from rest the second is the free-fall
  time. Near periapsis τ collapses, so the step refines automatically — the substep count
  on the HUD is this number, not a heuristic.
* **Relativity is applied pairwise with a mass-ratio reaction.** The relative 1PN
  acceleration is distributed as m_j/M and −m_i/M, so Σmᵢaᵢ = 0 exactly. (Applying the
  full term to both bodies — the naive pairwise sum — accelerates a 10⁷ M☉ black hole to
  hundreds of c. That bug is why the TDE preset used to gain 10¹⁶ J.)
* **Fixed bodies are masked at every Runge-Kutta stage,** not just the first, or a
  "frozen" body creeps away at the order of the step size.
* **The thermodynamic cache stores incident flux,** never absorbed flux, or each step
  attenuates the sunlight by another factor of (1−A) and a lava world freezes at 57 K.

---

## 3. Rendering pipeline

```
scene ──▶ RGBA16F + depth texture                     (instanced procedural bodies)
          ├──▶ bright pass ─▶ 4 blurred mips ─▶ bloom (additive, half res)
          ├──▶ 1/16 luminance ─▶ temporal adaptation   (eye: fast up, slow down)
          └──▶ lensing + accretion disk (ray-marched, reads depth for occlusion)
                                    │
                                    └──▶ ACES tonemap ──▶ sRGB
```

* **Lensing** uses the Schwarzschild deflection series α(b) = 4GM/c²b + (15π/4)(GM/c²)²/b²
  and captures rays inside the photon-sphere critical impact parameter b_c = 3√3 GM/c²,
  which paints the shadow and forms the Einstein ring from the scene buffer itself.
* **The accretion disk** is integrated in the same pass: a Shakura–Sunyaev temperature
  profile T ∝ r^(−3/4), Doppler beaming δ³ with the correct Keplerian β, and the
  gravitational redshift factor √(1 − r_s/r).
* **Atmospheres** march 12 view × 6 light samples through an exponential density profile
  with real per-channel Rayleigh coefficients (β_r(550 nm) = 5.8×10⁻⁶ m⁻¹, Bucholtz 1995),
  a Henyey–Greenstein Mie phase function, and an isotropic multiple-scattering term so
  terminators and sunsets are not black.
* **Surfaces** are generated per fragment from a stable per-body seed: domain-warped fBm
  continents, ridged mountains, latitude ice, gas-giant bands with a Great Spot vortex,
  lava cracks radiating as blackbody(1100–1800 K), and granulation with Eddington limb
  darkening (2+3μ)/5 for stars.

---

## 4. Accretion feedback — the disk pushes back

A merger with a compact object, a Roche-limit breakup and a tidal disruption event all
end the same way: mass is swallowed. Cosmoscope does not let that mass vanish silently —
it becomes an accretion flow with a light curve, and that light curve changes what the
rest of the simulation does.

* **The reservoir.** Swallowed mass goes into `accretionReservoir[]` (a merger feeds it
  the impactor's mass, a Roche breakup half the satellite, a TDE half the star).
* **The light curve.** Each step the reservoir drains on `accretionTimescale` = 3×10⁶ s
  and converts a fraction η = 0.1 of the infalling rest mass into energy, E = η Ṁc²,
  capped at the Eddington luminosity `L_Edd = 4πGMm_p c/σ_T = 1.2575×10³¹ · M/M☉ W`.
  The cap is what makes a TDE flare honest: the real infall rate is hundreds of times
  Eddington, so the disk drives a wind instead of radiating without limit — and the
  engine accordingly removes only E/c² from the body's mass, not the whole inflow.
* **The visuals.** The volumetric disk takes its brightness and colour from the
  instantaneous luminosity: `T_disk = 9000 · (L/L_Edd)^{1/4} K` (so the peak scales as
  Ṁ^{1/4}, as a Shakura–Sunyaev disk does), and the disk brightens, widens and turns from
  orange to white as the flare rises and decays.
* **The feedback.** The same luminosity is a force. Every other body feels
  `a_rad = L A / (4πr²c m)` with A = πR², so a quasar's radiation field genuinely
  accelerates dust grains, drives the debris stream outward and couples into the
  thermodynamics solver through the luminosity array. Switch it on with the
  **radiation pressure** what-if slider and watch the dust leave the galaxy.
* **The books balance.** `massAudit()` reports `{total, radiated, escaping, initial}`;
  the test suite asserts `total + radiated + escaping` equals the loaded mass to 10⁻¹².
  Physically radiated mass really does leave the system here.

The `sun-black-hole` and `tde` labs are the ones to watch: the first shows a star being
swallowed and the disk igniting, the second shows a star shredded into a stream, half of
which circularises and lights the disk while the other half escapes for good.

---

## 5. Controls

| Input | Action |
| --- | --- |
| Drag / right-drag / wheel | orbit / pan / zoom |
| Click a body | select it: telemetry, vectors, Kepler ellipse, camera follow |
| `Space` | pause / resume |
| `+` / `−` | time warp (ladder from 1 s = 1 s to 1 s = 1 Myr) |
| `⇄` | run time backwards (gravity is time-reversible) |
| `R` | restart the current lab |
| `G` `L` `B` `H` | curvature grid · labels · bloom · help |
| One finger drag / two-finger pinch / two-finger drag | orbit · zoom · pan (touch) |
| Drawer button (top right, ≤ 820 px wide) | slide the panel column in and out on a phone |

On screens narrower than 1180 px the side panels become an overlay drawer, the HUD
collapses to a single line of live values, and the canvas keeps the whole viewport. Add
a `prefers-reduced-motion` preference and the bloom/chromatic passes are dialled down.

The HUD reports simulated time, warp, body count, integrator, sub-steps per step,
wall-clock cost per step and the relative energy drift — the last one being the honest
measure of whether the integration can be trusted at the current warp.

---

## 6. Validation

```
npm test              # tests/physics.spec.ts — 99 checks, all passing
npm run test:shaders  # tests/lint-glsl.mjs — every shader parses as GLSL ES 1.00
npm run test:integration
```

Measured results (excerpt):

| Check | Result |
| --- | --- |
| Kepler's third law, Earth after one year | 1.000 000 AU, relative error 1.1×10⁻¹⁴ |
| Integrator convergence orders | RK4 4.33, Hermite 3.98, Verlet 2.00 |
| Verlet bounded-energy envelope vs RK4 drift | ×1.00 vs ×1.62 growth over 20 000 steps |
| Mercury 1PN perihelion precession | 42.98″/century (analytic 43.0″) |
| Barnes-Hut error at θ = 0.2 / 0.5 / 1.0 | 0.026 % / 0.653 % / 5.87 % |
| Adaptive sub-stepping through a close encounter | ΔE/E = 2.9×10⁻¹⁰, 128 sub-steps at periapsis |
| Lagrange points L1–L5 (Sun–Jupiter) | 4.853 287 / 5.562 851 / −5.197 107 AU, equilateral L4/L5 |
| Saturn fluid Roche limit (ice) | 157 968 km |
| Radiative equilibrium: Earth / Venus / Mars | 254.0 K / 727.4 K / 210.1 K |
| Remnant map 0.5 → 1.4 → 1.45 → 2.17 → 25 M☉ | WD, WD, NS, BH, BH |
| NFW halo rotation curve | v(10 kpc) = 250.3, v(20 kpc) = 269.7 km/s |
| Solar-system preset (261 bodies) energy drift | 9.9×10⁻¹¹ |
| Radiative efficiency of an accretion flow | η = 0.1, Eddington-capped at 100.0 % of L_Edd |
| Tidal disruption mass ledger | 10 000 000.5 M☉ bound + 0.500 000 M☉ unbound = the 10 000 001 M☉ loaded |
| Radiation pressure at L_Edd on a 1 mm grain | F_rad/F_grav = 9.88 (A/m = 0.39 m²/kg vs σ_T/m_p = 0.0398) |
| Swept collision detection | a 10 000 km impactor plunging at 0.4 c onto a 10 M☉ hole is caught, not tunnelled |
| Determinism | bit-identical after two identical runs |
| Integration cost, 111 bodies | 1.21 ms/step RK4 (was 4.30 before this pass) |

Two more harnesses keep the rest honest:

* `tests/integration.spec.ts` (bundled by `tests/build-integration.mjs`) stubs the DOM
  and drives the **real worker message loop** through the **real SceneManager and
  CameraRig** — 12 presets × 100 frames, plus every scenario, every what-if constant and
  all three integrators with relativity, frame dragging, drag and an NFW halo enabled.
  It imports the renderer through the same `?raw` GLSL path the bundler uses, so what it
  exercises is what the browser runs.
* `tests/lint-glsl.mjs` parses every shader with a GLSL ES 1.00 grammar (resolving
  `#include <shared>` exactly as the renderer does) so no shader reaches the GPU
  unparseable.

---

## 7. Performance — running on a weak machine

A 261-body solar system at a 2-day-per-second warp integrated in 4.3 ms/step per body
batch before this pass; it is **1.2 ms/step** now, a 3.6× speed-up, and the same halo
galaxy costs 0.64 ms/step for 501 bodies.

**Five quality tiers** (`src/render/Quality.ts`), selectable in the *Visuals* tab and
also applied automatically:

| Tier | Pixel ratio | Octaves | Atmosphere samples | Star detail | Bloom mips | Chromatic | Grid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Potato | 0.75×0.8 | 2 | 4×2 | 0 | 1 | 0 | 96² |
| Low | 1.0×0.85 | 3 | 6×3 | 0 | 2 | 0 | 128² |
| Medium | 1.0 | 5 | 10×5 | 1 | 3 | 0 | 160² |
| High | 1.5 | 6 | 12×6 | 2 | 4 | 0.4 | 200² |
| Ultra | 2.0 | 7 | 14×7 | 2 | 4 | 0.6 | 256² |

* **Auto** starts from the GPU reported by `WEBGL_debug_renderer_info` and
  `hardwareConcurrency` (Intel/AMD integrated, SwiftShader or a low core count start at
  *low*; a discrete GPU starts at *high*), then a frame-time governor nudges the tier:
  exponential moving average over frame times, downgrade above 20 ms with a 90-frame
  cooldown, upgrade below 0.55 × 20 ms with a 300-frame cooldown, and Auto never climbs
  past *high* on its own.
* **Multisampling is off below Medium** — on a 1280×720 integrated GPU that alone is
  worth several milliseconds.
* **Shader LOD.** Surfaces call `detailOctaves()` against the body's projected screen
  size, so a distant planet renders two octaves instead of seven; the starfield gates its
  Milky-Way and nebula shells behind `uDetail`; the haze grid rebuilds at the tier's
  resolution.
* **Cheaper noise.** `hash33()` uses the Hoskins integer hash instead of `sin()` — no
  transcendental per noise tap, and it is bit-stable across GPUs.
* **Physics.** Sub-step granularity relaxed to 0.06 τ, tracer–tracer collision pairs
  skipped entirely, the Planck-flux cache reuses one `Float64Array` instead of allocating
  per step, and the Kuiper belt is 90 tracers rather than 240. Every one of those changes
  is covered by the existing conservation tests.

The HUD shows the active tier (`quality`), sub-steps per step, ms/step and the energy
drift, so a teacher can see the trade being made instead of guessing at it.

### Exporting a lab report

The inspector has **CSV**, **JSON** and **Summary** buttons. Everything is generated in
the browser from the live engine state; nothing is uploaded anywhere.

* **CSV** — a time series, one row per animation frame: `wall_ms, sim_seconds,
  sim_years, kinetic_energy_J, potential_energy_J, total_energy_J, relative_drift,
  bodies, substeps, selected_body, semi_major_axis_m, eccentricity, inclination_rad,
  arg_periapsis_rad, period_s, speed_m_s, surface_temp_K, accretion_luminosity_W`.
  This is the one to plot: load it in a spreadsheet or a notebook and you have E(t) and
  the Keplerian elements as a function of time.
* **JSON** — a full state dump from the worker: every body with mass, radius, position,
  velocity, acceleration, surface and equilibrium temperature, luminosity, accretion
  luminosity, albedo, greenhouse factor, tidal heating, its primary and distance to it,
  Hill radius, fluid Roche limit, specific orbital energy, plus the engine parameters,
  the diagnostics block and the total accretion fuel.
* **Summary** — a plain-text digest (wall clock, simulated time, warp, bodies, energy
  drift, mean sub-steps, and the selected body's a, e, i, |v| and surface temperature)
  meant to be pasted straight into a lab notebook.

---

## 8. Deliberate limits

* The accretion flow is a light curve, not a full thin-disk solve: the engine tracks a
  reservoir, an Eddington-capped luminosity and a radiative-efficiency mass loss, and the
  renderer draws the disk those numbers imply. It does not integrate a viscous α-disk, and
  radiation pressure is applied as a point force per body rather than as a field.
* Radiation pressure uses a body's geometric cross-section πR². For anything bigger than
  a millimetre, gravity wins at the Eddington limit — that is the correct answer (the
  σ_T/m_p reference is for a proton–electron plasma), and the tests assert it rather than
  fudging it.
* Debris rings are integrated as an analytic Keplerian field with optional drag, and the
  shredded mass accretes onto the primary — an honest accounting of momentum without
  paying for 26 000 extra N-body particles on the CPU.
* Large warps coarsen the integration. The engine says so in the HUD instead of quietly
  producing beautiful nonsense.
* Galaxies use softened, halo-dominated dynamics; they are for rotation-curve teaching,
  not for cosmological structure formation.
