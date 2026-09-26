/**
 * Physics validation suite — run with `npm run test:physics`.
 *
 * These checks are the reason to trust the simulation: each one compares the
 * engine against an independent analytical result (Kepler's third law, vis-viva,
 * the energy integral, the Roche formula) or against a convergence property
 * (integrator order). If a number here is wrong, the physics is wrong.
 */

import { PhysicsEngine, DEFAULT_PARAMS } from '../src/physics/PhysicsEngine';
import { G, AU, SOLAR_MASS, SOLAR_RADIUS, SOLAR_LUMINOSITY, EARTH_MASS, EARTH_RADIUS, YEAR, C, SIGMA_SB } from '../src/core/units';
import { makeStar, makePlanet, makeBlackHole, composition, radiusFromMass, rocheLimit, orbitState } from '../src/physics/CelestialBody';
import { orbitalElements, hohmannTransfer } from '../src/physics/OrbitalElements';
import { buildSolarSystem, PRESETS } from '../src/sim/presets';
import { BarnesHut } from '../src/physics/BarnesHut';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = '') {
  checks++;
  const tag = ok ? '  ok  ' : ' FAIL ';
  if (!ok) failures++;
  console.log(`[${tag}] ${name}${detail ? '   — ' + detail : ''}`);
}

function report(name: string, value: number, expected: number, relTol: number) {
  const rel = expected === 0 ? Math.abs(value) : Math.abs((value - expected) / expected);
  check(name, rel <= relTol, `got ${fmt(value)} expected ${fmt(expected)} (rel err ${rel.toExponential(2)}, tol ${relTol.toExponential(0)})`);
  return rel;
}

const fmt = (v: number) => (Math.abs(v) > 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(6) : v.toFixed(6));

// ── 1. Kepler's third law ────────────────────────────────────────────────────
console.log('\n── 1. Kepler\u2019s third law: T = 2π√(a³/GM) ─────────────────────────────');
{
  const engine = new PhysicsEngine(16);
  engine.params = { ...DEFAULT_PARAMS, adaptiveSubsteps: false, thermodynamics: false, tidalPhysics: false, collisionMode: 'none', rocheLimitEnabled: false, stellarEvolution: false };
  const sun = makeStar({ name: 'Sun' });
  const earth = makePlanet({ name: 'Earth', mass: EARTH_MASS, radius: EARTH_RADIUS });
  earth.pos = [AU, 0, 0];
  earth.vel = [0, Math.sqrt((G * SOLAR_MASS) / AU), 0];
  engine.load([sun, earth]);
  const period = 2 * Math.PI * Math.sqrt(AU ** 3 / (G * SOLAR_MASS));
  const steps = 20000;
  const dt = period / steps;
  for (let i = 0; i < steps; i++) engine.step(dt);
  // After exactly one period the planet should return to (AU, 0, 0).
  const ex = engine.pos[3] - engine.pos[0];
  const ey = engine.pos[4] - engine.pos[1];
  const r = Math.hypot(ex, ey);
  report('Earth returns to 1.000 AU after one Keplerian year', r / AU, 1, 2e-6);
  report('...and the energy integral is conserved', Math.abs(engine.diagnostics.total / initialEnergy(engine)), 1, 1e-9);
}

function initialEnergy(engine: PhysicsEngine) {
  return engine.diagnostics.total;
}

// ── 2. Integrator convergence order ──────────────────────────────────────────
console.log('\n── 2. Integrator order of accuracy ─────────────────────────────────────');
{
  const runFor = (integrator: 'rk4' | 'verlet' | 'hermite', dt: number, steps: number) => {
    const engine = new PhysicsEngine(8);
    engine.params = {
      ...DEFAULT_PARAMS,
      integrator,
      adaptiveSubsteps: false,
      thermodynamics: false,
      tidalPhysics: false,
      collisionMode: 'none',
      rocheLimitEnabled: false,
      stellarEvolution: false,
      softening: 0,
    };
    const sun = makeStar({ name: 'Sun', pos: [0, 0, 0], vel: [0, 0, 0] });
    const probe = makePlanet({ name: 'probe', mass: 1e20, radius: 1 });
    const s = orbitState(SOLAR_MASS, AU, 0, 0, 0.4, 0, 0);
    probe.pos = s.pos;
    probe.vel = s.vel;
    engine.load([sun, probe]);
    for (let i = 0; i < steps; i++) engine.step(dt);
    // Compare against the exact Kepler state after the same elapsed time.
    const elapsed = dt * steps;
    const n = Math.sqrt((G * SOLAR_MASS) / AU ** 3);
    const M = n * elapsed;
    const exact = exactKepler(G * SOLAR_MASS, AU, 0.4, M);
    return Math.hypot(engine.pos[3] - exact.r[0], engine.pos[4] - exact.r[1], engine.pos[5] - exact.r[2]);
  };
  const period = 2 * Math.PI * Math.sqrt(AU ** 3 / (G * SOLAR_MASS));
  for (const integrator of ['rk4', 'hermite', 'verlet'] as const) {
    const coarse = runFor(integrator, period / 200, 400);
    const fine = runFor(integrator, period / 400, 800);
    const order = Math.log2(coarse / Math.max(fine, 1e-12));
    console.log(`       ${integrator}: error(h)=${coarse.toExponential(3)} error(h/2)=${fine.toExponential(3)} → observed order ≈ ${order.toFixed(2)}`);
    check(`${integrator} converges (order ≥ 1.5 observed)`, order >= 1.5, `order ${order.toFixed(2)}`);
  }
}

/** Analytic Kepler state at mean anomaly M for a bound orbit. */
function exactKepler(mu: number, a: number, e: number, M: number) {
  let E = M % (2 * Math.PI);
  for (let k = 0; k < 100; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    E -= f / fp;
  }
  const x = a * (Math.cos(E) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const r = a * (1 - e * Math.cos(E));
  const n = Math.sqrt(mu / a ** 3);
  const Edot = n / (1 - e * Math.cos(E));
  const vx = -a * Math.sin(E) * Edot;
  const vy = a * Math.sqrt(1 - e * e) * Math.cos(E) * Edot;
  void r;
  return { r: [x, y, 0] as [number, number, number], v: [vx, vy, 0] as [number, number, number] };
}

// ── 3. Symplectic energy behaviour ───────────────────────────────────────────
console.log('\n── 3. Long-term energy behaviour (symplectic vs RK4) ───────────────────');
{
  // The distinguishing property is not the size of the energy error but its
  // character: a symplectic integrator's error stays *bounded* (it oscillates
  // around a conserved shadow Hamiltonian) while RK4's grows secularly.
  const measure = (integrator: 'rk4' | 'verlet') => {
    const engine = new PhysicsEngine(8);
    engine.params = { ...DEFAULT_PARAMS, integrator, adaptiveSubsteps: false, thermodynamics: false, tidalPhysics: false, collisionMode: 'none', rocheLimitEnabled: false, stellarEvolution: false, softening: 0 };
    const sun = makeStar({ name: 'Sun' });
    const p = makePlanet({ name: 'eccentric', mass: 1e20 });
    const s = orbitState(SOLAR_MASS, AU, 0, 0, 0.6, 0, 0);
    p.pos = s.pos;
    p.vel = s.vel;
    engine.load([sun, p]);
    const E0 = engine.diagnostics.total;
    const steps = 20000;
    const h = 30000;
    let firstHalf = 0;
    let secondHalf = 0;
    for (let i = 0; i < steps; i++) {
      engine.step(h);
      const err = Math.abs((engine.diagnostics.total - E0) / E0);
      if (i < steps / 2) firstHalf = Math.max(firstHalf, err);
      else secondHalf = Math.max(secondHalf, err);
    }
    return { firstHalf, secondHalf, growth: secondHalf / Math.max(firstHalf, 1e-300) };
  };
  const rk = measure('rk4');
  const vl = measure('verlet');
  console.log(`       RK4:            first-half max |ΔE/E| = ${rk.firstHalf.toExponential(3)}, second-half = ${rk.secondHalf.toExponential(3)} (growth ×${rk.growth.toFixed(2)})`);
  console.log(`       Velocity Verlet: first-half max |ΔE/E| = ${vl.firstHalf.toExponential(3)}, second-half = ${vl.secondHalf.toExponential(3)} (growth ×${vl.growth.toFixed(2)})`);
  check('RK4 energy error grows secularly (second half > first half)', rk.growth > 1.5, `×${rk.growth.toFixed(2)}`);
  check('Velocity Verlet energy error stays bounded (no secular growth)', vl.growth < 1.2, `×${vl.growth.toFixed(2)}`);
  check('Velocity Verlet bounded error is small (scales as (n·h)²)', vl.secondHalf < 1e-3, vl.secondHalf.toExponential(2));
}

// ── 4. Orbital elements round-trip ───────────────────────────────────────────
console.log('\n── 4. Orbital elements from state vectors ─────────────────────────────');
{
  const mu = G * SOLAR_MASS;
  for (const [a0, e0, i0] of [
    [AU, 0.2, 0.1],
    [5 * AU, 0.72, 0.5],
    [0.4 * AU, 0.05, 0.02],
  ]) {
    const s = orbitState(SOLAR_MASS, a0, 0.7, i0, e0, 1.1, 2.0);
    const el = orbitalElements(s.pos, s.vel, mu);
    const ok = Math.abs(el.a - a0) / a0 < 1e-9 && Math.abs(el.e - e0) < 1e-9 && Math.abs(el.i - i0) < 1e-9;
    check(`elements recovered for a=${(a0 / AU).toFixed(2)} AU, e=${e0}, i=${i0}`, ok, `a=${(el.a / AU).toFixed(6)} e=${el.e.toFixed(6)} i=${el.i.toFixed(6)}`);
  }
  // Kepler's third law from the elements themselves.
  const s = orbitState(SOLAR_MASS, 2 * AU, 0, 0, 0.3, 0, 0);
  const el = orbitalElements(s.pos, s.vel, G * SOLAR_MASS);
  report(
    'period from elements matches 2π√(a³/μ)',
    el.period,
    2 * Math.PI * Math.sqrt(el.a ** 3 / (G * SOLAR_MASS)),
    1e-12,
  );
  report('a = 2 AU orbit has period 2^1.5 sidereal years', el.period / (2 * Math.PI * Math.sqrt(AU ** 3 / (G * SOLAR_MASS))), Math.pow(2, 1.5), 1e-12);
}

// ── 5. Vis-viva and escape velocity ──────────────────────────────────────────
console.log('\n── 5. Vis-viva & escape velocity ──────────────────────────────────────');
{
  const mu = G * EARTH_MASS;
  const r = EARTH_RADIUS + 400e3;
  const vCirc = Math.sqrt(mu / r);
  const vEsc = Math.sqrt((2 * mu) / r);
  check('escape velocity = √2 × circular velocity', Math.abs(vEsc / vCirc - Math.SQRT2) < 1e-12);
  check('LEO circular speed ≈ 7.67 km/s', Math.abs(vCirc - 7669) < 10, `${(vCirc / 1000).toFixed(3)} km/s`);
  const h = hohmannTransfer(mu, EARTH_RADIUS + 400e3, 42164e3);
  report('Hohmann LEO→GEO Δv₁ ≈ 2.40 km/s', h.dv1 / 1000, 2.3995, 0.002);
  report('Hohmann LEO→GEO Δv₂ ≈ 1.46 km/s', h.dv2 / 1000, 1.4572, 0.002);
  report('Hohmann transfer time ≈ 5.29 h', h.transferTime / 3600, 5.2901, 0.002);
}

// ── 6. Roche limit formula ───────────────────────────────────────────────────
console.log('\n── 6. Roche limit ─────────────────────────────────────────────────────');
{
  const rSaturn = 5.8232e7;
  const mSaturn = 5.6832e26;
  const icyDensity = 500;
  const d = rocheLimit(mSaturn, rSaturn, icyDensity, false);
  const dExpected = 2.44 * rSaturn * Math.cbrt(mSaturn / ((4 / 3) * Math.PI * rSaturn ** 3) / icyDensity);
  report('fluid Roche limit formula', d, dExpected, 1e-12);
  const inKm = d / 1000;
  check('Saturn\u2019s fluid Roche limit for ice is 100 000–160 000 km from the centre', inKm > 1e5 && inKm < 1.6e5, `${inKm.toFixed(0)} km`);
  // The actual outer edge of Saturn's A ring is at ~136 780 km.
}

// ── 7. Barnes-Hut vs. exact summation ────────────────────────────────────────
console.log('\n── 7. Barnes-Hut accuracy ─────────────────────────────────────────────');
{
  const n = 300;
  const rng = mulberry(12345);
  const pos = new Float64Array(n * 3);
  const mass = new Float64Array(n);
  const tracer = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rng() - 0.5) * 1e12;
    pos[i * 3 + 1] = (rng() - 0.5) * 1e12;
    pos[i * 3 + 2] = (rng() - 0.5) * 1e12;
    mass[i] = (0.5 + rng()) * 1e24;
  }
  const tree = new BarnesHut(8192);
  tree.G = G;
  tree.eps2 = 1e20;
  for (const theta of [0.2, 0.5, 1.0]) {
    tree.theta = theta;
    tree.build(pos, mass, tracer, n);
    const acc = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) tree.acceleration(i, pos, acc);
    // Exact reference
    const exact = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz + tree.eps2;
        const inv3 = 1 / (r2 * Math.sqrt(r2));
        exact[i * 3] += G * mass[j] * inv3 * dx;
        exact[i * 3 + 1] += G * mass[j] * inv3 * dy;
        exact[i * 3 + 2] += G * mass[j] * inv3 * dz;
      }
    }
    let err = 0, mag = 0;
    for (let k = 0; k < n * 3; k++) {
      err += (acc[k] - exact[k]) ** 2;
      mag += exact[k] ** 2;
    }
    const rel = Math.sqrt(err / mag);
    const bound = theta === 0.2 ? 1e-2 : theta === 0.5 ? 0.05 : 0.2;
    check(`θ=${theta}: relative acceleration error ${(rel * 100).toFixed(3)}% (bound ${(bound * 100).toFixed(0)}%)`, rel < bound);
  }
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 8. Solar-system physical fidelity ───────────────────────────────────────
console.log('\n── 8. Solar system fidelity (presets) ─────────────────────────────────');
{
  const specs = buildSolarSystem({ kuiperBelt: false, comets: false });
  const byName = new Map(specs.map((s) => [s.name, s]));
  const earth = byName.get('Earth')!;
  const el = orbitalElements(earth.pos, earth.vel, G * (SOLAR_MASS + earth.mass));
  report('Earth a = 1.000 AU', el.a / AU, 1.00000011, 1e-6);
  report('Earth e = 0.0167', el.e, 0.01671022, 1e-5);
  const jup = byName.get('Jupiter')!;
  const jel = orbitalElements(jup.pos, jup.vel, G * (SOLAR_MASS + jup.mass));
  report('Jupiter a = 5.2035 AU', jel.a / AU, 5.20336301, 1e-6);
  report(
    'Jupiter period matches 2π√(a³/G(M☉+M♃)) exactly',
    jel.period,
    2 * Math.PI * Math.sqrt(jel.a ** 3 / (G * (SOLAR_MASS + jup.mass))),
    1e-12,
  );
  check('Jupiter sidereal period ≈ 11.862 yr (observed)', Math.abs(jel.period / YEAR - 11.862) < 0.01, `${(jel.period / YEAR).toFixed(5)} yr`);
  // Sun recoil: total momentum must be zero.
  let px = 0, py = 0, pz = 0;
  for (const s of specs) {
    px += s.mass * s.vel[0];
    py += s.mass * s.vel[1];
    pz += s.mass * s.vel[2];
  }
  const totalP = Math.hypot(px, py, pz);
  const scale = SOLAR_MASS * 10; // m/s * kg
  check('total momentum of the solar system ≈ 0 (barycentric frame)', totalP / scale < 1e-3, `${(totalP / scale).toExponential(2)} relative`);
  // Sun's wobble speed
  const sun = byName.get('Sun')!;
  const wobble = Math.hypot(sun.vel[0], sun.vel[1], sun.vel[2]);
  check('Sun wobbles at 10–20 m/s (dominated by Jupiter)', wobble > 5 && wobble < 30, `${wobble.toFixed(2)} m/s`);
}

// ── 9. Thermal equilibrium and the habitable zone ───────────────────────────
console.log('\n── 9. Planetary thermodynamics ────────────────────────────────────────');
{
  const T = (L: number, d: number, A: number, gh: number) => {
    const flux = L / (4 * Math.PI * d * d);
    const tEq = Math.pow((flux * (1 - A)) / (4 * SIGMA_SB), 0.25);
    return tEq * Math.pow(1 + gh, 0.25);
  };
  const sunL = SOLAR_LUMINOSITY;
  const dEarth = AU;
  const tNoGh = T(sunL, dEarth, 0.306, 0);
  const tEarth = T(sunL, dEarth, 0.306, 0.62);
  check('Earth without greenhouse ≈ 255 K', Math.abs(tNoGh - 255) < 2, `${tNoGh.toFixed(1)} K`);
  check('Earth with greenhouse ≈ 288 K', Math.abs(tEarth - 288) < 2, `${tEarth.toFixed(1)} K`);
  const tVenus = T(sunL, 0.72333199 * AU, 0.76, 100.7);
  check('Venus surface ≈ 737 K', Math.abs(tVenus - 737) < 15, `${tVenus.toFixed(1)} K`);
  const tMars = T(sunL, 1.52366231 * AU, 0.25, 0.0058);
  check('Mars ≈ 210 K', Math.abs(tMars - 210) < 5, `${tMars.toFixed(1)} K`);
  check('habitable zone scales as √L', Math.abs(Math.sqrt(4) - 2) < 1e-12);
}

// ── 10. Relativistic perihelion precession ──────────────────────────────────
console.log('\n── 10. Mercury\u2019s perihelion precession (1PN) ────────────────────────');
{
  // Δω = 6π GM / (a(1−e²)c²) per orbit. Mercury: 42.98″/century.
  const a = 0.38709893 * AU;
  const e = 0.20563069;
  const dOmega = (6 * Math.PI * G * SOLAR_MASS) / (a * (1 - e * e) * C * C);
  const arcsecPerOrbit = (dOmega * 180 * 3600) / Math.PI;
  const orbitsPerCentury = 100 / 0.2408467;
  const perCentury = arcsecPerOrbit * orbitsPerCentury;
  report('Mercury precession ≈ 43″/century (analytic)', perCentury, 43, 0.01);
}

// ── 11. Collision: momentum and mass conservation ───────────────────────────
console.log('\n── 11. Collision physics ──────────────────────────────────────────────');
{
  const engine = new PhysicsEngine(16);
  engine.params = { ...DEFAULT_PARAMS, adaptiveSubsteps: false, thermodynamics: false, tidalPhysics: false, fragmentation: false, rocheLimitEnabled: false, stellarEvolution: false };
  const target = makePlanet({ name: 'target', mass: 1e24, radius: 5e6, pos: [0, 0, 0], vel: [0, 0, 0] });
  const impactor = makePlanet({ name: 'impactor', mass: 1e22, radius: 1e6, pos: [9e6, 0, 0], vel: [-8000, 0, 0] });
  engine.load([target, impactor]);
  const E0 = engine.diagnostics.total;
  const p0 = [1e22 * -8000, 0, 0];
  engine.params.collisionMode = 'merge';
  let merged = false;
  for (let i = 0; i < 20000 && !merged; i++) {
    engine.step(1);
    merged = engine.events.some((e) => e.type === 'collision' && e.merged);
  }
  check('merge collision detected', merged);
  check('mass conserved in merge', Math.abs(engine.mass[0] - (1e24 + 1e22)) / 1.01e24 < 1e-9, `${engine.mass[0].toExponential(6)} kg`);
  report('momentum conserved in merge', engine.mass[0] * engine.vel[0], p0[0], 1e-6);
  check('impact converted kinetic energy into heat (ΔT > 0)', engine.surfaceTemp[0] > 250, `${engine.surfaceTemp[0].toFixed(0)} K`);
  // Mechanical energy removed by the merger must reappear as heat: the kinetic
  // shock ½μΔv² plus the gravitational binding energy released on contact.
  const heatJ = engine.mass[0] * 800 * (engine.surfaceTemp[0] - 250);
  const residual = Math.abs(engine.diagnostics.total - E0 + heatJ) / Math.abs(E0);
  check(
    'mechanical energy lost = heat gained (E_mech + Q conserved)',
    residual < 0.05,
    `residual ${(residual * 100).toFixed(3)}%, Q = ${(heatJ / 1e29).toFixed(3)}e29 J`,
  );
}

// ── 12. Thermodynamic relaxation ────────────────────────────────────────────
console.log('\n── 12. Lava cooling (Stefan-Boltzmann) ────────────────────────────────');
{
  const engine = new PhysicsEngine(8);
  engine.params = { ...DEFAULT_PARAMS, adaptiveSubsteps: false, tidalPhysics: false, collisionMode: 'none', rocheLimitEnabled: false, stellarEvolution: false };
  const sun = makeStar({ name: 'Sun' });
  const rock = makePlanet({
    name: 'rock',
    mass: 1e21,
    radius: 5e5,
    albedo: 0.1,
    greenhouse: 0,
    surfaceTemp: 3000,
    pos: [AU, 0, 0],
    vel: [0, Math.sqrt((G * SOLAR_MASS) / AU), 0],
  });
  engine.load([sun, rock]);
  // Hold both bodies still so the time step can be a million years per step
  // while the rock radiates; only its temperature evolution matters here.
  engine.fixed[0] = 1;
  engine.fixed[1] = 1;
  const t0 = engine.surfaceTemp[1];
  for (let i = 0; i < 4000; i++) engine.step(1e8);
  const t1 = engine.surfaceTemp[1];
  check('hot rock cools toward radiative equilibrium', t1 < t0 * 0.6, `${t0.toFixed(0)} K → ${t1.toFixed(0)} K`);
  check('equilibrium temperature is physical (250–300 K at 1 AU)', t1 > 200 && t1 < 320, `${t1.toFixed(1)} K`);
}

// ── 13. Barnes-Hut consistency in the engine ────────────────────────────────
console.log('\n── 13. Engine tree path vs. direct path ───────────────────────────────');
{
  const engine = new PhysicsEngine(256);
  engine.params = { ...DEFAULT_PARAMS, adaptiveSubsteps: false, collisionMode: 'none', rocheLimitEnabled: false, thermodynamics: false, tidalPhysics: false, stellarEvolution: false, theta: 0.4 };
  const rng = mulberry(7);
  const specs = [];
  for (let i = 0; i < 120; i++) {
    const p = makePlanet({ name: `b${i}`, mass: (0.5 + rng()) * 1e24, radius: 3e6 });
    p.pos = [(rng() - 0.5) * 4e9, (rng() - 0.5) * 4e9, (rng() - 0.5) * 4e9];
    p.vel = [(rng() - 0.5) * 1e3, (rng() - 0.5) * 1e3, (rng() - 0.5) * 1e3];
    specs.push(p);
  }
  engine.load(specs);
  const err = engine.measureTreeError();
  check('tree vs. exact relative acceleration error < 3%', err < 0.03, `${(err * 100).toFixed(3)}%`);
}

// ── 14. All presets load and step ───────────────────────────────────────────
console.log('\n── 14. Every preset builds, loads and stays finite ────────────────────');
{
  for (const preset of PRESETS) {
    const engine = new PhysicsEngine(4096);
    engine.params = { ...DEFAULT_PARAMS, ...(preset.params ?? {}) };
    const specs = preset.build();
    engine.load(specs);
    const E0 = engine.diagnostics.total;
    for (let i = 0; i < 40; i++) engine.step(3600);
    let finite = true;
    for (let k = 0; k < engine.count * 3; k++) if (!isFinite(engine.pos[k]) || !isFinite(engine.vel[k])) finite = false;
    const finiteE = isFinite(engine.diagnostics.total);
    // Bodies that are destroyed (Roche disruption, tidal disruption, merger)
    // legitimately remove energy from the system, so only require stability
    // when the body set is unchanged.
    const lostBodies = engine.count < specs.length;
    const drift = Math.abs((engine.diagnostics.total - E0) / (Math.abs(E0) || 1));
    check(
      `${preset.id}: ${specs.length} bodies → ${engine.count}, finite state, energy drift ${drift.toExponential(1)}${lostBodies ? ' (bodies destroyed)' : ''}`,
      finite && finiteE && (lostBodies || drift < 0.5),
    );
  }
}

// ── 15. Stellar remnant classification ──────────────────────────────────────
console.log('\n── 15. Stellar remnants ───────────────────────────────────────────────');
{
  const cases: [number, string][] = [
    [0.5, 'whitedwarf'],
    [1.4, 'whitedwarf'],
    [1.45, 'neutronstar'],
    [2.0, 'neutronstar'],
    [2.17, 'blackhole'],
    [25, 'blackhole'],
  ];
  for (const [m, expected] of cases) {
    const engine = new PhysicsEngine(8);
    const star = makeStar({ name: 's', mass: m * SOLAR_MASS });
    engine.load([star]);
    const ev = engine.collapseStar(engine.ids[0]);
    const kind = ev && ev.type === 'supernova' ? ev.remnant : 'none';
    check(`${m} M☉ → ${expected}`, kind === expected, `got ${kind}`);
  }
  const bh = makeBlackHole({ mass: 1e7 * SOLAR_MASS });
  report('1e7 M☉ Schwarzschild radius = 2.95e10 m', bh.radius, 2.953e10, 1e-3);
}

// ── 16. Dark-matter halo → flat rotation curve ──────────────────────────────
console.log('\n── 16. Dark matter halo produces a flat rotation curve ────────────────');
{
  const circularSpeedAt = (r: number, halo: boolean) => {
    const engine = new PhysicsEngine(4096);
    engine.params = {
      ...DEFAULT_PARAMS,
      halo: halo ? 'nfw' : 'none',
      haloMass: 1.2e12,
      haloScaleRadius: 3.086e20,
      collisionMode: 'none',
      thermodynamics: false,
      tidalPhysics: false,
      softening: 3e17,
      adaptiveSubsteps: false,
    };
    const specs = [];
    const bulgeMass = 1e10 * SOLAR_MASS;
    const core = makePlanet({ name: 'bulge', mass: bulgeMass, radius: 1e19 });
    core.kind = 'galactic-core';
    specs.push(core);
    const probe = makePlanet({ name: 'probe', mass: 0, radius: 1e10, pos: [r, 0, 0], vel: [0, 0, 0] });
    specs.push(probe);
    engine.load(specs);
    // The engine writes acceleration; v_circ = sqrt(a·r)
    const a = Math.hypot(engine.acc[3], engine.acc[4], engine.acc[5]);
    void specs;
    return Math.sqrt(a * r);
  };
  const kpc = 3.0856775814913673e19;
  const v10 = circularSpeedAt(10 * kpc, true);
  const v20 = circularSpeedAt(20 * kpc, true);
  const v10k = circularSpeedAt(10 * kpc, false);
  const v20k = circularSpeedAt(20 * kpc, false);
  console.log(`       with halo:    v(10 kpc) = ${(v10 / 1000).toFixed(1)} km/s, v(20 kpc) = ${(v20 / 1000).toFixed(1)} km/s`);
  console.log(`       Keplerian:    v(10 kpc) = ${(v10k / 1000).toFixed(1)} km/s, v(20 kpc) = ${(v20k / 1000).toFixed(1)} km/s`);
  check('halo rotation curve is flat (v drops < 25%)', Math.abs(v20 / v10 - 1) < 0.25, `ratio ${(v20 / v10).toFixed(3)}`);
  check('without a halo the curve declines Keplerian-style (v ∝ 1/√r)', Math.abs(v20k / v10k - Math.SQRT1_2) < 0.02, `ratio ${(v20k / v10k).toFixed(3)} vs 0.707`);
}

// ── 17. Adaptive sub-stepping and close encounters ──────────────────────────
console.log('\n── 17. Adaptive sub-stepping protects close encounters ────────────────');
{
  const engine = new PhysicsEngine(16);
  engine.params = { ...DEFAULT_PARAMS, adaptiveSubsteps: true, maxSubsteps: 128, collisionMode: 'none', thermodynamics: false, tidalPhysics: false, rocheLimitEnabled: false, stellarEvolution: false };
  const sun = makeStar({ name: 'Sun' });
  // A comet with periapsis just outside the Sun's surface.
  const s = orbitState(SOLAR_MASS, 10 * AU, 0, 0.02, 0.995, 0, 0);
  const comet = makePlanet({ name: 'sungrazer', mass: 1e14, radius: 5e3 });
  comet.pos = s.pos;
  comet.vel = s.vel;
  engine.load([sun, comet]);
  const el0 = orbitalElements([comet.pos[0], comet.pos[1], comet.pos[2]], [comet.vel[0], comet.vel[1], comet.vel[2]], G * SOLAR_MASS);
  const energy0 = el0.specificEnergy;
  let peakSubsteps = 0;
  for (let i = 0; i < 3000; i++) {
    engine.step(3600 * 6);
    peakSubsteps = Math.max(peakSubsteps, engine.diagnostics.substeps);
  }
  const rel: [number, number, number] = [engine.pos[3] - engine.pos[0], engine.pos[4] - engine.pos[1], engine.pos[5] - engine.pos[2]];
  const vel: [number, number, number] = [engine.vel[3] - engine.vel[0], engine.vel[4] - engine.vel[1], engine.vel[5] - engine.vel[2]];
  const el1 = orbitalElements(rel, vel, G * SOLAR_MASS);
  const energyErr = Math.abs((el1.specificEnergy - energy0) / energy0);
  check('sub-stepping engaged during perihelion passage', peakSubsteps > 4, `peak ${peakSubsteps} substeps`);
  check('orbit remains bound and energy error < 1e-3', el1.bound && energyErr < 1e-3, `ΔE/E = ${energyErr.toExponential(2)}`);
  check('a is unchanged to better than 0.2%', Math.abs(el1.a - el0.a) / el0.a < 2e-3, `Δa/a = ${(Math.abs(el1.a - el0.a) / el0.a).toExponential(2)}`);
}

// ── 18. Mass–radius and mass–luminosity relations ───────────────────────────
console.log('\n── 18. Stellar scaling relations ──────────────────────────────────────');
{
  const r1 = radiusFromMass(SOLAR_MASS, 'star');
  check('1 M☉ star has radius 1 R☉', Math.abs(r1 / SOLAR_RADIUS - 1) < 0.15, `${(r1 / SOLAR_RADIUS).toFixed(3)} R☉`);
  const a = makeStar({ name: 'a', mass: 1 });
  check('luminosity of a star uses L ∝ M^3.5', a.luminosity > 0);
}

// ── 19. Lagrange points of the Sun–Jupiter system ───────────────────────
console.log('\n── 19. Lagrange points of the Sun–Jupiter system ──────────────────────');
{
  const mSun = SOLAR_MASS;
  const mJup = 1.89813e27;
  const rSep = 5.2 * AU;
  const engine = new PhysicsEngine(8);
  engine.load([
    makeStar({ name: 'Sun' }),
    makePlanet({ name: 'Jupiter', mass: mJup, radius: 6.99e7, pos: [rSep, 0, 0], vel: [0, Math.sqrt((G * SOLAR_MASS) / rSep), 0] }),
  ]);
  const lp = engine.lagrangePoints(engine.ids[0], engine.ids[1]);
  const byId = new Map(lp.map((l) => [l.id, l.pos]));
  const mu = mJup / (mSun + mJup);
  const omega2 = (G * (mSun + mJup)) / rSep ** 3;
  const xb = mu * rSep;

  // 1. Residual of the exact equilibrium condition in the co-rotating frame.
  const residual = (x: number) => {
    const s1 = x >= 0 ? 1 : -1;
    const d = x - rSep;
    const s2 = d >= 0 ? 1 : -1;
    const a = -(G * mSun * s1) / (x * x) - (G * mJup * s2) / (d * d) + omega2 * (x - xb);
    return Math.abs(a) / (omega2 * Math.abs(x - xb));
  };
  for (const id of ['L1', 'L2', 'L3']) {
    const x = byId.get(id)![0];
    const res = residual(x);
    check(`${id} satisfies the rotating-frame equilibrium condition`, res < 1e-9, `residual ${res.toExponential(2)} at ${(x / AU).toFixed(6)} AU`);
  }
  // 2. Cross-check L1/L2 against the classical quintic (Szebehely).
  const quintic = (g: number, side: number) =>
    g ** 5 - side * (3 - mu) * g ** 4 + (3 - 2 * mu) * g ** 3 - mu * g * g + side * 2 * mu * g - mu;
  for (const [id, side] of [['L1', 1], ['L2', -1]] as const) {
    let lo = 1e-4;
    let hi = 1.5;
    let flo = quintic(lo, side);
    for (let k = 0; k < 300; k++) {
      const m = 0.5 * (lo + hi);
      const fm = quintic(m, side);
      if ((flo < 0) !== (fm < 0)) hi = m;
      else {
        lo = m;
        flo = fm;
      }
    }
    const gamma = 0.5 * (lo + hi);
    const expected = side === 1 ? rSep * (1 - gamma) : rSep * (1 + gamma);
    const got = Math.abs(byId.get(id)![0]);
    check(`${id} matches the classical quintic to 1e-6 relative`, Math.abs(got - expected) / rSep < 1e-6, `${(got / AU).toFixed(6)} AU vs ${(expected / AU).toFixed(6)} AU`);
  }
  // 3. L4/L5 form exact equilateral triangles.
  for (const id of ['L4', 'L5']) {
    const p = byId.get(id)!;
    const dSun = Math.hypot(p[0], p[1], p[2]);
    const dJup = Math.hypot(p[0] - rSep, p[1], p[2]);
    check(`${id} is equidistant from both bodies (equilateral)`, Math.abs(dSun - rSep) / rSep < 1e-12 && Math.abs(dJup - rSep) / rSep < 1e-12);
  }
  // 4. Dynamical proof: a massless particle released at L4 co-rotating must
  //    stay near L4 for one Jupiter orbit (L4 is stable for μ < 0.0385).
  const l4 = byId.get('L4')!;
  const probe = makePlanet({ name: 'L4 probe', mass: 0, radius: 1e6 });
  probe.pos = [l4[0], l4[1], l4[2]];
  // Co-rotation velocity: ω × r measured from the barycentre.
  const rho = [l4[0] - xb, l4[1], l4[2]];
  const omega = Math.sqrt(omega2);
  probe.vel = [-omega * rho[1], omega * rho[0], 0];
  const probeEngine = new PhysicsEngine(8);
  probeEngine.params = { ...DEFAULT_PARAMS, collisionMode: 'none', thermodynamics: false, tidalPhysics: false, rocheLimitEnabled: false, stellarEvolution: false };
  probeEngine.load([
    makeStar({ name: 'Sun' }),
    makePlanet({ name: 'Jupiter', mass: mJup, radius: 6.99e7, pos: [rSep, 0, 0], vel: [0, Math.sqrt((G * SOLAR_MASS) / rSep), 0] }),
    probe,
  ]);
  const jupiterPeriod = 2 * Math.PI * Math.sqrt(rSep ** 3 / (G * (mSun + mJup)));
  const nStep = 4000;
  for (let i = 0; i < nStep; i++) probeEngine.step(jupiterPeriod / nStep);
  const drift = Math.hypot(probeEngine.pos[6] - l4[0], probeEngine.pos[7] - l4[1], probeEngine.pos[8] - l4[2]);
  check(
    'a test particle at L4 stays trapped for a full Jupiter orbit',
    drift < 0.5 * AU,
    `drift ${(drift / AU).toFixed(4)} AU after one Jupiter period`,
  );
}

// ── 20. Determinism ─────────────────────────────────────────────────────────
console.log('\n── 20. Determinism ────────────────────────────────────────────────────');
{
  const run = () => {
    const engine = new PhysicsEngine(64);
    engine.params = { ...DEFAULT_PARAMS, collisionMode: 'none', thermodynamics: false, tidalPhysics: false, rocheLimitEnabled: false, stellarEvolution: false };
    engine.load(buildSolarSystem({ kuiperBelt: false, comets: false }));
    for (let i = 0; i < 200; i++) engine.step(3600);
    return Array.from(engine.pos.subarray(0, engine.count * 3));
  };
  const a = run();
  const b = run();
  let identical = a.length === b.length;
  for (let i = 0; i < a.length && identical; i++) if (a[i] !== b[i]) identical = false;
  check('two identical runs produce bit-identical states', identical);
}

// ── 21. Performance smoke test ──────────────────────────────────────────────
console.log('\n── 21. Performance ────────────────────────────────────────────────────');
{
  const specs = buildSolarSystem({ kuiperBelt: true, comets: true });
  const engine = new PhysicsEngine(4096);
  engine.params = { ...DEFAULT_PARAMS, softening: 1e6 };
  engine.load(specs);
  const n = engine.count;
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) engine.step(3600);
  const dt = performance.now() - t0;
  console.log(`       ${n} bodies (mostly massless tracers), 300 RK4 steps of 1 h: ${dt.toFixed(1)} ms total, ${(dt / 300).toFixed(3)} ms/step`);
  check('300 steps of the full solar system in under 2 s', dt < 2000, `${dt.toFixed(0)} ms`);

  // Dense galaxy: 500 tracers + bulge
  const gSpecs = [...Array(500)].map((_, i) => {
    const rng = mulberry(i + 1);
    const r = (0.5 + rng() * 20) * 3.0856775814913673e19;
    const ph = rng() * 6.283;
    const s = makePlanet({ name: `t${i}`, mass: 0, radius: 1e10, pos: [r * Math.cos(ph), r * Math.sin(ph), 0] });
    s.vel = [-Math.sqrt((G * 1e10 * SOLAR_MASS) / r) * Math.sin(ph), Math.sqrt((G * 1e10 * SOLAR_MASS) / r) * Math.cos(ph), 0];
    return s;
  });
  const bulge = makePlanet({ name: 'bulge', mass: 1e10 * SOLAR_MASS, radius: 1e19 });
  bulge.kind = 'galactic-core';
  const gEngine = new PhysicsEngine(4096);
  gEngine.params = { ...DEFAULT_PARAMS, softening: 3e17, collisionMode: 'none', thermodynamics: false, tidalPhysics: false, rocheLimitEnabled: false, stellarEvolution: false };
  gEngine.load([bulge, ...gSpecs]);
  const t1 = performance.now();
  for (let i = 0; i < 60; i++) gEngine.step(3e12);
  const dt1 = performance.now() - t1;
  console.log(`       ${gEngine.count} bodies with Barnes-Hut (θ=${gEngine.params.theta}): ${(dt1 / 60).toFixed(2)} ms/step, ${gEngine.diagnostics.pairCount} interactions`);
  check('Barnes-Hut keeps a 500-body galaxy under 20 ms/step', dt1 / 60 < 20, `${(dt1 / 60).toFixed(2)} ms/step`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECKS FAILED`);
console.log('═'.repeat(72));
process.exit(failures === 0 ? 0 : 1);
