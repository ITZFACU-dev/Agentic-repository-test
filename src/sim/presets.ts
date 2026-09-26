/**
 * Curated learning modules and interactive presets.
 *
 * Every preset is built from real physical data — J2000 orbital elements,
 * measured masses and radii, observed albedos and greenhouse forcing — so the
 * simulator reproduces the actual solar system rather than a cartoon. Each
 * preset also declares the camera framing, the physics toggles that make its
 * point, and the overlay(s) that make it legible.
 */

import {
  AU,
  DAY,
  EARTH_RADIUS,
  JUPITER_MASS,
  JUPITER_RADIUS,
  MOON_MASS,
  MOON_RADIUS,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
  YEAR,
} from '../core/units';
import { makeRng } from '../core/mathx';
import { makeBlackHole, makePlanet, makeStar, atmosphere, composition, type BodySpec } from '../physics/CelestialBody';
import { stateFromElements } from '../physics/OrbitalElements';
import type { PhysicsParams } from '../physics/PhysicsEngine';

export interface Preset {
  id: string;
  name: string;
  category: 'solar' | 'chaos' | 'orbital' | 'extreme' | 'galactic' | 'sandbox';
  blurb: string;
  /** Long-form teaching notes shown in the info panel. */
  lesson: string;
  /** Key numbers worth reading off the HUD while the preset runs. */
  watchFor: string[];
  build: () => BodySpec[];
  /** Physics overrides applied when the preset loads. */
  params?: Partial<PhysicsParams>;
  /** Camera framing. */
  camera: { focus: string; distance: number; elevation?: number };
  /** Suggested time warp, simulated seconds per wall-clock second. */
  timeWarp?: number;
  /** Overlays to switch on automatically. */
  overlays?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Data tables — J2000 orbital elements (a, e, i, Ω, ω̄) and physical constants
// ─────────────────────────────────────────────────────────────────────────────

interface PlanetData {
  name: string;
  mass: number;
  radius: number;
  a: number; // AU
  e: number;
  i: number; // deg
  node: number; // deg
  peri: number; // deg, longitude of perihelion (ω + Ω)
  m0: number; // deg, mean anomaly at J2000
  albedo: number;
  greenhouse: number;
  spinHours: number; // sidereal rotation period (negative = retrograde)
  tilt: number; // axial tilt, deg
  color: [number, number, number];
  internalHeat?: number;
  waterFraction?: number;
  kind?: BodySpec['kind'];
  note?: string;
  rings?: { inner: number; outer: number; opacity: number };
}

const PLANETS: PlanetData[] = [
  {
    name: 'Mercury',
    mass: 3.3011e23,
    radius: 2.4397e6,
    a: 0.38709893,
    e: 0.20563069,
    i: 7.00487,
    node: 48.33167,
    peri: 77.45645,
    m0: 174.796,
    albedo: 0.088,
    greenhouse: 0,
    spinHours: 1407.6,
    tilt: 0.034,
    color: [0.42, 0.4, 0.37],
    note: 'Most eccentric planet. Its 43″/century perihelion precession was the first confirmation of general relativity — enable the 1PN toggle and watch the argument of periapsis drift.',
  },
  {
    name: 'Venus',
    mass: 4.8675e24,
    radius: 6.0518e6,
    a: 0.72333199,
    e: 0.00677323,
    i: 3.39471,
    node: 76.68069,
    peri: 131.53298,
    m0: 50.115,
    albedo: 0.76,
    greenhouse: 100.7,
    spinHours: -5832.5,
    tilt: 177.36,
    color: [0.86, 0.78, 0.62],
    internalHeat: 0,
    note: 'A runaway greenhouse: it absorbs less sunlight than Earth per m² yet its surface is 737 K — hot enough to melt lead.',
  },
  {
    name: 'Earth',
    mass: 5.97217e24,
    radius: EARTH_RADIUS,
    a: 1.00000011,
    e: 0.01671022,
    i: 0.00005,
    node: -11.26064,
    peri: 102.94719,
    m0: 357.5291,
    albedo: 0.306,
    greenhouse: 0.62,
    spinHours: 23.9345,
    tilt: 23.44,
    color: [0.12, 0.3, 0.62],
    internalHeat: 4.7e13,
    waterFraction: 0.71,
    note: 'Venus and Earth receive comparable sunlight; the 500 K difference is entirely atmospheric. Turn the greenhouse slider in the inspector to see why.',
  },
  {
    name: 'Mars',
    mass: 6.4171e23,
    radius: 3.3895e6,
    a: 1.52366231,
    e: 0.09341233,
    i: 1.85061,
    node: 49.57854,
    peri: 336.04084,
    m0: 19.412,
    albedo: 0.25,
    greenhouse: 0.0058,
    spinHours: 24.6229,
    tilt: 25.19,
    color: [0.62, 0.32, 0.2],
    note: 'Thin CO₂ atmosphere: only 5.8 W/m² of greenhouse forcing versus Earth\u2019s 150 W/m².',
  },
  {
    name: 'Jupiter',
    mass: JUPITER_MASS,
    radius: JUPITER_RADIUS,
    a: 5.20336301,
    e: 0.04839266,
    i: 1.3053,
    node: 100.55615,
    peri: 14.75385,
    m0: 19.65,
    albedo: 0.503,
    greenhouse: 0.2,
    spinHours: 9.925,
    tilt: 3.13,
    color: [0.78, 0.68, 0.55],
    internalHeat: 3.35e17,
    note: 'It radiates 1.6× more energy than it absorbs — it is still contracting. Its mass is 318 Earths, which is why the Sun\u2019s barycentric wobble has a 12-year period.',
  },
  {
    name: 'Saturn',
    mass: 5.6832e26,
    radius: 5.8232e7,
    a: 9.53707032,
    e: 0.0541506,
    i: 2.48446,
    node: 113.71504,
    peri: 92.43194,
    m0: 317.02,
    albedo: 0.342,
    greenhouse: 0.15,
    spinHours: 10.656,
    tilt: 26.73,
    color: [0.85, 0.78, 0.6],
    internalHeat: 8.7e16,
    rings: { inner: 7.45e7, outer: 1.4e8, opacity: 0.75 },
    note: 'The rings lie inside the Roche limit — that is exactly why they cannot coalesce into a moon.',
  },
  {
    name: 'Uranus',
    mass: 8.6811e25,
    radius: 2.5362e7,
    a: 19.19126393,
    e: 0.04716771,
    i: 0.76986,
    node: 74.22988,
    peri: 170.96424,
    m0: 142.2386,
    albedo: 0.3,
    greenhouse: 0.1,
    spinHours: -17.24,
    tilt: 97.77,
    color: [0.55, 0.82, 0.86],
    note: 'Axial tilt 98°: it rolls around its orbit, most likely after a giant impact.',
  },
  {
    name: 'Neptune',
    mass: 1.02409e26,
    radius: 2.4622e7,
    a: 30.06896348,
    e: 0.00858587,
    i: 1.76917,
    node: 131.72169,
    peri: 44.97135,
    m0: 256.225,
    albedo: 0.29,
    greenhouse: 0.12,
    spinHours: 16.11,
    tilt: 28.32,
    color: [0.28, 0.45, 0.85],
    internalHeat: 1.3e16,
    note: 'Discovered by prediction, not observation: Newton\u2019s laws said a body had to be there, and it was found within 1°.',
  },
  {
    name: 'Pluto',
    mass: 1.303e22,
    radius: 1.188e6,
    a: 39.48168677,
    e: 0.24880766,
    i: 17.14175,
    node: 110.30347,
    peri: 224.06676,
    m0: 14.53,
    albedo: 0.52,
    greenhouse: 0.002,
    spinHours: -153.29,
    tilt: 122.53,
    color: [0.72, 0.64, 0.55],
    kind: 'dwarf',
    note: 'In a 3:2 mean-motion resonance with Neptune (two Pluto orbits ≈ three Neptune orbits). Never collides with Neptune, despite crossing its orbit.',
  },
];

interface MoonData {
  name: string;
  parent: string;
  mass: number;
  radius: number;
  a: number; // km
  e: number;
  i: number; // deg
  albedo: number;
  color: [number, number, number];
  greenhouse?: number;
  note?: string;
}

const MOONS: MoonData[] = [
  { name: 'Moon', parent: 'Earth', mass: MOON_MASS, radius: MOON_RADIUS, a: 384400, e: 0.0549, i: 5.145, albedo: 0.12, color: [0.55, 0.55, 0.53], note: 'Tidally locked: it rotates once per orbit, so the same face always points at Earth.' },
  { name: 'Io', parent: 'Jupiter', mass: 8.9319e22, radius: 1.8216e6, a: 421700, e: 0.0041, i: 0.05, albedo: 0.63, color: [0.9, 0.85, 0.4], note: 'The most volcanically active body known. Its 4:2:1 resonance with Europa and Ganymede forces its eccentricity to stay non-zero, so tidal heating never stops — read the tidal heating figure in the inspector.' },
  { name: 'Europa', parent: 'Jupiter', mass: 4.7998e22, radius: 1.5608e6, a: 671034, e: 0.009, i: 0.47, albedo: 0.67, color: [0.85, 0.82, 0.75] },
  { name: 'Ganymede', parent: 'Jupiter', mass: 1.4819e23, radius: 2.6341e6, a: 1070412, e: 0.0013, i: 0.2, albedo: 0.43, color: [0.62, 0.58, 0.55] },
  { name: 'Callisto', parent: 'Jupiter', mass: 1.0759e23, radius: 2.4103e6, a: 1882709, e: 0.0074, i: 0.19, albedo: 0.22, color: [0.4, 0.36, 0.33] },
  { name: 'Titan', parent: 'Saturn', mass: 1.3452e23, radius: 2.5747e6, a: 1221870, e: 0.0288, i: 0.35, albedo: 0.22, color: [0.85, 0.6, 0.25], note: 'Thick nitrogen atmosphere (1.5 bar) — the only moon with a dense atmosphere.' },
  { name: 'Enceladus', parent: 'Saturn', mass: 1.08e20, radius: 2.52e5, a: 237948, e: 0.0047, i: 0.02, albedo: 0.81, color: [0.92, 0.95, 0.97], note: 'Cryovolcanic plumes: tidal heating supplying a subsurface ocean through 1.4 GW of dissipation.' },
  { name: 'Triton', parent: 'Neptune', mass: 2.139e22, radius: 1.3534e6, a: 354759, e: 0.000016, i: 156.9, albedo: 0.76, color: [0.8, 0.78, 0.75] },
  { name: 'Charon', parent: 'Pluto', mass: 1.586e21, radius: 6.06e5, a: 19591, e: 0.0002, i: 0.08, albedo: 0.38, color: [0.6, 0.58, 0.56] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

export function buildSolarSystem(opts: { kuiperBelt?: boolean; comets?: boolean } = { kuiperBelt: true, comets: true }): BodySpec[] {
  const specs: BodySpec[] = [];
  const sun = makeStar({
    name: 'Sun',
    mass: SOLAR_MASS,
    radius: SOLAR_RADIUS,
    luminosity: SOLAR_LUMINOSITY,
    temp: 5772,
    spinRate: (2 * Math.PI) / (25.38 * DAY),
    note: 'The Sun holds 99.86 % of the mass of the solar system, yet the barycentre sits outside its surface when Jupiter and Saturn align.',
  });
  specs.push(sun);
  const sunIndex = 0;

  // Momentum bookkeeping: we want the system's barycentre at rest so the Sun
  // visibly wobbles around it instead of the whole system drifting away.
  let pTotal: [number, number, number] = [0, 0, 0];

  const indexByName = new Map<string, number>();
  for (const p of PLANETS) {
    const mu = 6.6743e-11 * (SOLAR_MASS + p.mass);
    const argPeri = ((p.peri - p.node) * Math.PI) / 180;
    // Position the planet at the J2000 mean anomaly (converted to true anomaly).
    const state = meanAnomalyState(
      mu,
      p.a * AU,
      p.e,
      (p.i * Math.PI) / 180,
      (p.node * Math.PI) / 180,
      argPeri,
      (p.m0 * Math.PI) / 180,
    );
    const spec = makePlanet({
      name: p.name,
      mass: p.mass,
      radius: p.radius,
      composition: composition({ rock: p.name === 'Jupiter' || p.name === 'Saturn' ? 0.15 : 0.7, gas: p.name === 'Jupiter' || p.name === 'Saturn' ? 0.85 : 0.05, metal: 0.1 }),
      albedo: p.albedo,
      greenhouse: p.greenhouse,
      color: p.color,
      seed: hashSeed(p.name),
      spinRate: (2 * Math.PI) / (p.spinHours * 3600),
      spinAxis: tiltAxis(p.tilt),
      internalHeat: p.internalHeat ?? 0,
      waterFraction: p.waterFraction ?? 0,
      note: p.note,
      oblateness: p.name === 'Jupiter' || p.name === 'Saturn' ? 0.065 : 0.003,
      magneticMoment: 0,
    });
    spec.kind = p.kind ?? 'planet';
    spec.pos = state.r;
    spec.vel = state.v;
    if (p.rings) {
      spec.rings = {
        innerRadius: p.rings.inner,
        outerRadius: p.rings.outer,
        opacity: p.rings.opacity,
        tilt: 0,
        seed: hashSeed(p.name + 'rings'),
      };
    }
    if (p.name === 'Earth' || p.name === 'Venus' || p.name === 'Titan') {
      spec.atmosphere = atmosphere(
        p.name === 'Earth'
          ? {}
          : p.name === 'Venus'
            ? { scaleHeight: 15900, rayleigh: [2.6e-5, 2.4e-5, 1.9e-5], mie: 6e-5, density: 4, ozone: 0.1 }
            : { scaleHeight: 21500, rayleigh: [3.4e-5, 3.1e-5, 2.4e-5], mie: 4e-5, density: 3, ozone: 0.2 },
      );
    }
    specs.push(spec);
    indexByName.set(p.name, specs.length - 1);
    pTotal = [
      pTotal[0] + p.mass * spec.vel[0],
      pTotal[1] + p.mass * spec.vel[1],
      pTotal[2] + p.mass * spec.vel[2],
    ];
  }

  // Moons: circular-ish orbits around their parent, correct relative speeds.
  for (const m of MOONS) {
    const parentIndex = indexByName.get(m.parent);
    if (parentIndex === undefined) continue;
    const parent = specs[parentIndex];
    const mu = 6.6743e-11 * parent.mass;
    const r = m.a * 1000;
    const state = meanAnomalyState(mu, r, m.e, (m.i * Math.PI) / 180, 0, 0, (hashSeed(m.name) % 628) / 100);
    const spec = makePlanet({
      name: m.name,
      mass: m.mass,
      radius: m.radius,
      composition: composition({ rock: 0.8, ice: 0.15, metal: 0.05 }),
      albedo: m.albedo,
      greenhouse: m.greenhouse ?? 0,
      color: m.color,
      seed: hashSeed(m.name),
      spinRate: Math.sqrt(mu / r ** 3), // tidally locked to the primary
      internalHeat: 0,
      note: m.note,
      waterFraction: m.name === 'Europa' || m.name === 'Enceladus' ? 0.9 : 0,
    });
    spec.kind = 'moon';
    spec.pos = [parent.pos[0] + state.r[0], parent.pos[1] + state.r[1], parent.pos[2] + state.r[2]];
    spec.vel = [parent.vel[0] + state.v[0], parent.vel[1] + state.v[1], parent.vel[2] + state.v[2]];
    specs.push(spec);
    indexByName.set(m.name, specs.length - 1);
  }

  if (opts.comets) {
    // 1P/Halley: a famous retrograde, highly eccentric comet.
    const mu = 6.6743e-11 * SOLAR_MASS;
    const halley = meanAnomalyState(mu, 17.834 * AU, 0.96714, (162.26 * Math.PI) / 180, (58.42 * Math.PI) / 180, (111.33 * Math.PI) / 180, 0.3);
    const spec = makePlanet({
      name: '1P/Halley',
      mass: 2.2e14,
      radius: 5.5e3,
      composition: composition({ ice: 0.7, rock: 0.3 }),
      albedo: 0.04,
      color: [0.3, 0.3, 0.32],
      seed: 1234,
      note: 'Halley returns every 76 years. Its orbit is retrograde — its inclination is 162°.',
    });
    spec.kind = 'comet';
    spec.pos = halley.r;
    spec.vel = halley.v;
    specs.push(spec);
  }
  if (opts.comets) {
    const mu = 6.6743e-11 * SOLAR_MASS;
    const hale = meanAnomalyState(mu, 186 * AU, 0.995, (89.4 * Math.PI) / 180, (282.5 * Math.PI) / 180, (111.4 * Math.PI) / 180, 3.1);
    const spec = makePlanet({
      name: 'C/1995 O1 Hale–Bopp',
      mass: 1e16,
      radius: 3.0e4,
      composition: composition({ ice: 0.8, rock: 0.2 }),
      albedo: 0.05,
      color: [0.35, 0.35, 0.45],
      seed: 4321,
      note: 'Inbound from 3700 AU; a single perihelion passage spends 1.4 % of its orbit inside Neptune\u2019s distance.',
    });
    spec.kind = 'comet';
    spec.pos = hale.r;
    spec.vel = hale.v;
    specs.push(spec);
  }
  if (opts.kuiperBelt) {
    // Kuiper belt: massless tracers on circular orbits between 34 and 50 AU.
    const rng = makeRng(20240501);
    const mu = 6.6743e-11 * SOLAR_MASS;
    for (let i = 0; i < 240; i++) {
      const a = 34 + Math.pow(rng(), 0.7) * 16;
      const inc = (rng() - 0.5) * 0.35;
      const node = rng() * Math.PI * 2;
      const phase = rng() * Math.PI * 2;
      const state = meanAnomalyState(mu, a * AU, rng() * 0.12, inc, node, 0, phase);
      const tracer: BodySpec = {
        id: 0,
        name: `KBO ${i + 1}`,
        kind: 'asteroid',
        mass: 0,
        radius: 5e4 * (0.5 + rng()),
        pos: state.r,
        vel: state.v,
        spinAxis: [0, 0, 1],
        spinRate: 0,
        albedo: 0.1,
        greenhouse: 0,
        luminosity: 0,
        internalHeat: 0,
        surfaceTemp: 45,
        color: [0.35, 0.34, 0.36],
        seed: (rng() * 1e6) | 0,
        composition: composition({ ice: 0.6, rock: 0.4 }),
        note: 'Kuiper-belt object — a massless tracer, so it feels gravity but does not perturb the planets.',
      };
      specs.push(tracer);
    }
  }

  // Zero the total momentum: the Sun absorbs the recoil, and consequently
  // wobbles about the barycentre as Jupiter and Saturn swing around.
  specs[sunIndex].vel = [-pTotal[0] / SOLAR_MASS, -pTotal[1] / SOLAR_MASS, -pTotal[2] / SOLAR_MASS];
  return specs;
}

/** State vector at mean anomaly M for classical elements. */
function meanAnomalyState(
  mu: number,
  a: number,
  e: number,
  inclination: number,
  node: number,
  argPeri: number,
  meanAnomaly: number,
): { r: [number, number, number]; v: [number, number, number] } {
  // Newton solve for the eccentric anomaly, then convert to true anomaly.
  let E = e < 0.8 ? meanAnomaly : Math.PI;
  const M = ((meanAnomaly % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (let k = 0; k < 80; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-15) break;
  }
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  // Eccentric anomaly → true anomaly.
  const trueAnomaly = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);
  return stateFromElements(mu, a, e, inclination, node, argPeri, trueAnomaly);
}

function tiltAxis(tiltDeg: number): [number, number, number] {
  const t = (tiltDeg * Math.PI) / 180;
  // Tilt away from the orbital-plane normal (z) toward x.
  return [Math.sin(t), 0, Math.cos(t)];
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 8) % 100000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────────────────


function figureEight(): BodySpec[] {
  // Chenciner–Montgomery figure-eight choreography in canonical units
  // (G = m = 1), rescaled: length → AU, mass → M☉, so the period is ~1.0 yr.
  const L = AU;
  const V = Math.sqrt((6.6743e-11 * SOLAR_MASS) / AU);
  const base: { p: [number, number, number]; v: [number, number, number] }[] = [
    { p: [-0.97000436, 0.24308753, 0], v: [0.466203685, 0.43236573, 0] },
    { p: [0.97000436, -0.24308753, 0], v: [0.466203685, 0.43236573, 0] },
    { p: [0, 0, 0], v: [-0.93240737, -0.86473146, 0] },
  ];
  return base.map((b, i) =>
    makeStar({
      name: `Star ${String.fromCharCode(65 + i)}`,
      mass: SOLAR_MASS,
      radius: SOLAR_RADIUS * 0.7,
      luminosity: SOLAR_LUMINOSITY * 0.6,
      pos: [b.p[0] * L, b.p[1] * L, b.p[2] * L],
      vel: [b.v[0] * V, b.v[1] * V, b.v[2] * V],
      note: 'One of the three bodies in the figure-eight choreography: each traces the same curve, 120° out of phase. Published by Chenciner & Montgomery in 2000.',
    }),
  );
}

function pythagoreanProblem(): BodySpec[] {
  // Burrau's problem: masses 3, 4 and 5 released from rest. Chaotic, and the
  // eventual outcome is the ejection of the lightest body.
  const L = AU;
  const data = [
    { m: 3, p: [1, 3] },
    { m: 4, p: [-2, -1] },
    { m: 5, p: [1, -1] },
  ];
  return data.map((d, i) =>
    makeStar({
      name: `Body ${d.m}`,
      mass: d.m * SOLAR_MASS,
      radius: SOLAR_RADIUS * (0.6 + 0.2 * i),
      luminosity: SOLAR_LUMINOSITY * 0.5,
      pos: [d.p[0] * L, d.p[1] * L, 0],
      vel: [0, 0, 0],
      note: 'Burrau\u2019s (Pythagorean) problem, 1913: three masses 3, 4 and 5 released from rest. The eventual result is the ejection of the lightest body and a bound binary — but only chaos can tell you which.',
    }),
  );
}

function threeBodyChaos(): BodySpec[] {
  // Sun–Jupiter–Saturn with a small perturbation; the classic outer-solar-system
  // chaos experiment, plus a 1 m displaced copy to measure divergence.
  const specs = buildSolarSystem({ kuiperBelt: false, comets: false });
  // Keep Sun..Saturn plus Uranus, Neptune (already there); add an identical
  // "ghost" Earth displaced by one metre to visualise Lyapunov divergence.
  const earthIndex = specs.findIndex((s) => s.name === 'Earth');
  const earth = specs[earthIndex];
  const ghost = makePlanet({
    name: 'Earth (ghost)',
    // Massless: a shadow trajectory in the same gravitational field. If it had
    // Earth's mass the two copies would attract each other with 4e14 m/s².
    mass: 0,
    radius: earth.radius,
    composition: earth.composition,
    albedo: earth.albedo,
    greenhouse: earth.greenhouse,
    color: [0.9, 0.25, 0.25],
    seed: 4242,
    note: 'An exact copy of Earth displaced by exactly one metre. Watch how quickly it separates: that is deterministic chaos, not numerical error.',
  });
  ghost.pos = [earth.pos[0] + 1, earth.pos[1], earth.pos[2]];
  ghost.vel = [earth.vel[0], earth.vel[1], earth.vel[2]];
  ghost.kind = 'planet';
  return [...specs, ghost];
}

function hohmannLab(): BodySpec[] {
  const EARTH_M = 5.97217e24;
  const mu = 6.6743e-11 * EARTH_M;
  const specs: BodySpec[] = [];
  const earth = makePlanet({
    name: 'Earth',
    mass: EARTH_M,
    radius: EARTH_RADIUS,
    composition: composition({ rock: 0.67, water: 0.3, metal: 0.03 }),
    albedo: 0.306,
    greenhouse: 0.62,
    color: [0.12, 0.3, 0.62],
    waterFraction: 0.71,
    atmosphere: atmosphere(),
    seed: 1001,
    note: 'Frame: Earth-centred. The satellite below is a massless tracer, so it feels Earth\u2019s gravity without perturbing the planet.',
  });
  earth.pos = [0, 0, 0];
  earth.vel = [0, 0, 0];
  earth.fixed = true; // hold the planet still so the orbit is clean to read
  earth.spinRate = 7.2921e-5;
  specs.push(earth);

  const rLEO = EARTH_RADIUS + 400e3;
  const rGEO = 4.2164e7;
  const { r, v } = stateFromElements(mu, (rLEO + rGEO) / 2, 0.0, 0, 0, 0, 0);
  // Start the transfer at LEO with a tangential Δv of 2.45 km/s.
  const leo = stateFromElements(mu, rLEO, 0, 0, 0, 0, 0);
  const vCircLEO = Math.sqrt(mu / rLEO);
  const vPerigeeTransfer = Math.sqrt(mu * (2 / rLEO - 2 / (rLEO + rGEO)));
  void r;
  void v;
  const sat = makePlanet({
    name: 'Satellite',
    mass: 0, // massless tracer
    radius: 2e4,
    composition: composition({ metal: 1, rock: 0 }),
    albedo: 0.4,
    color: [0.9, 0.9, 0.95],
    seed: 77,
    note: 'Massless tracer at LEO with a prograde Δv of 2.45 km/s — enough to raise apogee to geostationary altitude. Δv at apogee circularises the orbit.',
  });
  sat.pos = leo.r;
  const dir = Math.hypot(leo.v[0], leo.v[1], leo.v[2]) || 1;
  const boost = vPerigeeTransfer - vCircLEO;
  sat.vel = [
    leo.v[0] + (leo.v[0] / dir) * boost,
    leo.v[1] + (leo.v[1] / dir) * boost,
    leo.v[2] + (leo.v[2] / dir) * boost,
  ];
  sat.kind = 'asteroid';
  specs.push(sat);

  const geo = makePlanet({
    name: 'GEO ring',
    mass: 0,
    radius: 4e4,
    composition: composition({ metal: 1 }),
    albedo: 0.5,
    color: [0.5, 0.85, 1.0],
    seed: 78,
    note: 'A reference marker in the circular geostationary orbit at 42 164 km (period 23 h 56 m — same as Earth\u2019s rotation).',
  });
  const geostate = stateFromElements(mu, rGEO, 0, 0, 0, 0, Math.PI);
  geo.pos = geostate.r;
  geo.vel = geostate.v;
  geo.kind = 'asteroid';
  specs.push(geo);
  return specs;
}

function gravityAssistLab(): BodySpec[] {
  const specs = buildSolarSystem({ kuiperBelt: false, comets: false });
  const jupiter = specs.find((s) => s.name === 'Jupiter')!;
  // A spacecraft on a Hohmann-like approach to Jupiter; the flyby redirects it
  // onto an escape trajectory. Massless so it does not perturb Jupiter.
  const mu = 6.6743e-11 * SOLAR_MASS;
  const state = meanAnomalyState(mu, 5.2 * AU, 0.72, 0.078, 0.5, 0.3, 3.05);
  const craft = makePlanet({
    name: 'Voyager-class probe',
    mass: 0,
    radius: 3e5,
    composition: composition({ metal: 1 }),
    albedo: 0.5,
    color: [0.95, 0.95, 0.6],
    seed: 555,
    note: 'Approaches Jupiter at 6 km/s relative to the planet; leaves at 20 km/s, having taken the difference out of Jupiter\u2019s orbital energy. Momentum is conserved — Jupiter slows by ~1 cm/s.',
  });
  craft.kind = 'asteroid';
  craft.pos = state.r;
  craft.vel = state.v;
  void jupiter;
  return [...specs, craft];
}

function rocheLab(): BodySpec[] {
  const specs: BodySpec[] = [];
  const planet = makePlanet({
    name: 'gas giant',
    mass: 1.2 * JUPITER_MASS,
    radius: 1.15 * JUPITER_RADIUS,
    composition: composition({ gas: 0.9, rock: 0.1 }),
    albedo: 0.5,
    color: [0.8, 0.72, 0.6],
    seed: 909,
    rings: { innerRadius: 1.5 * JUPITER_RADIUS, outerRadius: 2.3 * JUPITER_RADIUS, opacity: 0.5, tilt: 0, seed: 5 },
    note: 'A 1.2 M♃ gas giant. A moon placed inside its Roche radius cannot hold itself together.',
  });
  planet.pos = [0, 0, 0];
  specs.push(planet);
  const mu = 6.6743e-11 * planet.mass;
  const aStart = 3.2 * JUPITER_RADIUS;
  // Start a little past apoapsis so the moon is visibly inbound for a while
  // before tidal stress exceeds its self-gravity at periapsis.
  const state = meanAnomalyState(mu, aStart, 0.42, 0.09, 0, 0, 3.0);
  const moon = makePlanet({
    name: 'doomed moon',
    mass: 1e21,
    radius: 4.5e5,
    composition: composition({ ice: 0.5, rock: 0.5 }),
    albedo: 0.5,
    color: [0.75, 0.8, 0.85],
    seed: 910,
    note: 'Its periapsis dips inside the 2.44 R_M (ρ_M/ρ_m)^{1/3} Roche radius, where tidal stress exceeds self-gravity. Watch it become a ring.',
  });
  moon.kind = 'moon';
  moon.pos = state.r;
  moon.vel = state.v;
  specs.push(moon);
  return specs;
}

function tidalHeatingLab(): BodySpec[] {
  const specs = buildSolarSystem({ kuiperBelt: false, comets: false });
  return specs.filter((s) => ['Sun', 'Jupiter', 'Io', 'Europa', 'Ganymede', 'Callisto'].includes(s.name));
}

function tdeLab(): BodySpec[] {
  const specs: BodySpec[] = [];
  const hole = makeBlackHole({
    name: 'Supermassive black hole',
    mass: 1e7 * SOLAR_MASS,
    spin: 0.9,
    note: 'A 10⁷ M☉ Kerr hole. Its Schwarzschild radius is 2.95×10⁷ km — 42 times the radius of the Sun — yet a Sun-like star is torn apart 100× further out.',
  });
  specs.push(hole);
  const mu = 6.6743e-11 * hole.mass;
  const rPeri = 12 * SOLAR_RADIUS * Math.cbrt(hole.mass / SOLAR_MASS); // ~ periapsis
  const a = 60 * rPeri;
  const e = 1 - rPeri / a;
  const state = meanAnomalyState(mu, a, e, 0.22, 0, 0, Math.PI * 0.985);
  const star = makeStar({
    name: 'unfortunate star',
    mass: SOLAR_MASS,
    radius: SOLAR_RADIUS,
    luminosity: SOLAR_LUMINOSITY,
    temp: 5772,
    pos: state.r,
    vel: state.v,
    note: 'Tidal radius R_★ (M_BH/m_★)^{1/3} ≈ 12 R☉ × 215 ≈ 2600 R☉. Long before it reaches the horizon, the near side is pulled much harder than the far side.',
  });
  specs.push(star);
  // An accretion disk around the hole: a ring of massless tracers.
  const rng = makeRng(88);
  for (let i = 0; i < 220; i++) {
    const r = hole.radius * (6 + rng() * 24);
    const phase = rng() * Math.PI * 2;
    const inc = (rng() - 0.5) * 0.12;
    // Schwarzschild circular-orbit speed as measured by a static observer:
    // v = √(GM/r) / √(1 − R_s/r) — it diverges at the photon sphere, r = 1.5 R_s.
    const vCirc = Math.sqrt(mu / r) / Math.sqrt(Math.max(1 - hole.radius / r, 1e-3));
    const tracer: BodySpec = {
      id: 0,
      name: `disk ${i}`,
      kind: 'asteroid',
      mass: 0,
      radius: 1e7,
      pos: [r * Math.cos(phase), r * Math.sin(phase) * Math.cos(inc), r * Math.sin(phase) * Math.sin(inc)],
      vel: [-vCirc * Math.sin(phase), vCirc * Math.cos(phase) * Math.cos(inc), vCirc * Math.cos(phase) * Math.sin(inc)],
      spinAxis: [0, 0, 1],
      spinRate: 0,
      albedo: 0,
      greenhouse: 0,
      luminosity: 0,
      internalHeat: 0,
      surfaceTemp: 8000 + rng() * 12000,
      color: [1.0, 0.6, 0.25],
      seed: (rng() * 1e6) | 0,
      composition: composition({ gas: 1 }),
    };
    specs.push(tracer);
  }
  return specs;
}

function galaxyLab(withHalo: boolean): BodySpec[] {
  const specs: BodySpec[] = [];
  const bulgeMass = 1e10 * SOLAR_MASS;
  const bulge = makePlanet({
    name: 'Galactic bulge',
    mass: bulgeMass,
    radius: 3.086e19, // ~1 kpc
    composition: composition({ gas: 0.5, rock: 0.5 }),
    albedo: 0,
    luminosity: 0,
    color: [1.0, 0.85, 0.5],
    seed: 2024,
    internalHeat: 0,
    note: 'A 10¹⁰ M☉ bulge. Stars orbiting outside its visible extent should slow down like planets (Keplerian decline) — but observed galaxies do not.',
  });
  bulge.kind = 'galactic-core';
  specs.push(bulge);

  const rng = makeRng(31337);
  const kpc = 3.0856775814913673e19;
  const mu = 6.6743e-11 * bulgeMass;
  for (let i = 0; i < 420; i++) {
    const r = (0.5 + Math.pow(rng(), 0.55) * 19.5) * kpc;
    const phase = rng() * Math.PI * 2;
    const z = (rng() - 0.5) * 0.12 * r;
    const vc = Math.sqrt(mu / r);
    const tracer: BodySpec = {
      id: 0,
      name: `star ${i}`,
      kind: 'asteroid',
      mass: 0,
      radius: 2e10,
      pos: [r * Math.cos(phase), r * Math.sin(phase), z],
      vel: [-vc * Math.sin(phase), vc * Math.cos(phase), 0],
      spinAxis: [0, 0, 1],
      spinRate: 0,
      albedo: 0,
      greenhouse: 0,
      luminosity: 0,
      internalHeat: 0,
      surfaceTemp: 6000,
      color: [0.9, 0.9, 1.0],
      seed: (rng() * 1e6) | 0,
      composition: composition({ gas: 1 }),
      note: 'A massless test star. Its orbital speed traces the rotation curve.',
    };
    specs.push(tracer);
  }
  void withHalo;
  return specs;
}

function sunToBlackHole(): BodySpec[] {
  const specs = buildSolarSystem({ kuiperBelt: false, comets: false });
  const sun = specs[0];
  const hole: BodySpec = {
    ...makeBlackHole({ name: 'Sun (same mass)', mass: sun.mass, spin: 0.05 }),
    pos: sun.pos,
    vel: sun.vel,
    note: 'Identical mass, identical position, identical velocity — and the planets do not care. Orbits depend on mass, not on surface. Only the sunlight disappears.',
  };
  specs[0] = hole;
  return specs;
}

function impactLab(): BodySpec[] {
  const specs = buildSolarSystem({ kuiperBelt: false, comets: false });
  const earthIndex = specs.findIndex((s) => s.name === 'Earth');
  const earth = specs[earthIndex];
  // A 12 km Chicxulub-class impactor arriving at 20 km/s.
  const vx = 20000;
  const impactor = makePlanet({
    name: 'Chicxulub impactor',
    mass: 1.0e15,
    radius: 6e3,
    composition: composition({ rock: 0.6, metal: 0.3, ice: 0.1 }),
    albedo: 0.08,
    color: [0.25, 0.22, 0.2],
    seed: 6500,
    note: '12 km across, 10¹⁵ kg, closing at 20 km/s. Q = ½μΔv² ≈ 2×10²³ J: the 100-trillion-tonne TNT equivalent that ended the Cretaceous.',
  });
  impactor.kind = 'asteroid';
  // Place it on a collision course: Earth's position, offset along +x, with the
  // velocity needed to arrive in ~40 simulated days.
  const lead = 6e7;
  impactor.pos = [earth.pos[0] - lead, earth.pos[1] + lead * 0.15, earth.pos[2]];
  impactor.vel = [earth.vel[0] + vx * 0.95, earth.vel[1] - vx * 0.3, earth.vel[2]];
  return [...specs, impactor];
}

function collapseLab(): BodySpec[] {
  const specs: BodySpec[] = [];
  const star = makeStar({
    name: 'Betelgeuse-class star',
    mass: 25 * SOLAR_MASS,
    temp: 3600,
    note: 'A 25 M☉ red supergiant. Above the TOV limit (2.17 M☉), so its core cannot become a neutron star: it must collapse to a black hole.',
  });
  specs.push(star);
  const mu = 6.6743e-11 * star.mass;
  const state = meanAnomalyState(mu, 12 * AU, 0.2, 0.1, 0, 0, 1.2);
  const companion = makeStar({
    name: 'companion star',
    mass: 2.4 * SOLAR_MASS,
    temp: 9000,
    pos: state.r,
    vel: state.v,
    note: 'Its orbit is unaffected by the collapse: the gravitational field outside a spherically symmetric body depends only on its mass.',
  });
  specs.push(companion);
  return specs;
}

function binaryStarLab(): BodySpec[] {
  const specs: BodySpec[] = [];
  const m1 = 1.1 * SOLAR_MASS;
  const m2 = 0.9 * SOLAR_MASS;
  const sep = 0.6 * AU;
  const total = m1 + m2;
  const r1 = (sep * m2) / total;
  const r2 = (sep * m1) / total;
  const vRel = Math.sqrt((6.6743e-11 * total) / sep);
  const a = makeStar({ name: 'Primary (1.1 M☉)', mass: m1, pos: [-r1, 0, 0], vel: [0, (-vRel * m2) / total, 0], temp: 6200 });
  const b = makeStar({ name: 'Secondary (0.9 M☉)', mass: m2, pos: [r2, 0, 0], vel: [0, (vRel * m1) / total, 0], temp: 5400 });
  specs.push(a, b);
  // A circumbinary planet at 4 AU — a real configuration (Kepler-16b).
  const mu = 6.6743e-11 * total;
  const pState = meanAnomalyState(mu, 4.0 * AU, 0.05, 0.02, 0, 0, 0.6);
  const planet = makePlanet({
    name: 'circumbinary planet',
    mass: 0.33 * JUPITER_MASS,
    radius: 0.75 * JUPITER_RADIUS,
    composition: composition({ gas: 0.8, rock: 0.2 }),
    albedo: 0.35,
    color: [0.85, 0.75, 0.6],
    seed: 4711,
    note: 'Planets can form in binary systems: Kepler-16b orbits two stars every 229 days.',
  });
  planet.pos = pState.r;
  planet.vel = pState.v;
  specs.push(planet);
  return specs;
}

function sandbox(): BodySpec[] {
  const sun = makeStar({ name: 'Sun', mass: SOLAR_MASS, radius: SOLAR_RADIUS, luminosity: SOLAR_LUMINOSITY, temp: 5772 });
  const earth = makePlanet({
    name: 'Earth',
    mass: 5.97217e24,
    radius: EARTH_RADIUS,
    composition: composition({ rock: 0.67, water: 0.3, metal: 0.03 }),
    albedo: 0.306,
    greenhouse: 0.62,
    color: [0.12, 0.3, 0.62],
    waterFraction: 0.71,
    atmosphere: atmosphere(),
    seed: 1001,
  });
  const s = stateFromElements(6.6743e-11 * SOLAR_MASS, AU, 0.0167, 0, 0, 0, 0);
  earth.pos = s.r;
  earth.vel = s.v;
  return [sun, earth];
}

// ─────────────────────────────────────────────────────────────────────────────

export const PRESETS: Preset[] = [
  {
    id: 'solar-system',
    name: 'The Solar System',
    category: 'solar',
    blurb: 'Eight planets, nine moons, two comets and the Kuiper belt from real J2000 elements.',
    lesson:
      'Built from published J2000 orbital elements and measured masses, so the planets sit where they actually were at epoch. The Sun is given the recoil velocity of the whole system, which is why it visibly wobbles around the barycentre — mostly driven by Jupiter. Open the inspector on Earth and note that its equilibrium temperature comes out near 288 K only because of greenhouse forcing: remove it and the surface would sit below freezing.',
    watchFor: [
      'The Sun\u2019s barycentric wobble (it leaves the origin as Jupiter swings round)',
      'Earth\u2019s energy error staying flat with RK4 at 1-day steps',
      'Venus at 737 K versus Earth at 288 K, with nearly identical insolation',
    ],
    build: () => buildSolarSystem({ kuiperBelt: true, comets: true }),
    camera: { focus: 'Sun', distance: 14 * AU, elevation: 0.55 },
    timeWarp: 2 * DAY,
    overlays: ['habitable'],
  },
  {
    id: 'three-body-figure8',
    name: 'Figure-8 Choreography',
    category: 'chaos',
    blurb: 'Three equal stars sharing one orbit — a periodic solution found in 2000.',
    lesson:
      'For 300 years the only known solution to the three-body problem was Lagrange\u2019s. In 2000 Chenciner and Montgomery proved the existence of a periodic orbit in which three equal masses chase each other around a single figure-eight curve, each 120° out of phase. It is unstable: perturb any body by a metre and the dance breaks up in a few dozen orbits.',
    watchFor: ['The identical path traced by all three stars', 'How a 1 m perturbation destroys the pattern'],
    build: figureEight,
    camera: { focus: 'Star C', distance: 3.2 * AU },
    timeWarp: 0.05 * YEAR,
    overlays: ['vectors', 'trails'],
  },
  {
    id: 'three-body-pythagorean',
    name: 'Burrau\u2019s Problem (3-4-5)',
    category: 'chaos',
    blurb: 'Three masses released from rest: the original chaotic three-body experiment.',
    lesson:
      'Carl Burrau posed this in 1913 with masses 3, 4 and 5 released from rest at the corners of a 3-4-5 triangle. After a handful of close encounters one body is ejected and the other two form a tight binary. Which body leaves is decided by encounters on scales of kilometres inside a system 10¹¹ m across: the outcome is deterministic but unpredictable.',
    watchFor: ['The vote between 3 and 4 for which escapes', 'Close encounters where the adaptive sub-stepper engages'],
    build: pythagoreanProblem,
    camera: { focus: 'Body 5', distance: 14 * AU },
    timeWarp: 0.02 * YEAR,
    overlays: ['vectors', 'trails', 'potential'],
  },
  {
    id: 'chaos-lyapunov',
    name: 'Chaos & Lyapunov Divergence',
    category: 'chaos',
    blurb: 'The solar system with a one-metre displaced Earth: measure the butterfly effect.',
    lesson:
      'Two identical Earths, one displaced by exactly one metre. Their separation grows exponentially, |δ(t)| ≈ δ₀e^{λt}, where λ is the largest Lyapunov exponent. The energy-conservation graph stays flat throughout, proving the divergence is physics, not numerical error. Watch the ln|δ| plot in the telemetry panel for the slope.',
    watchFor: ['Separation doubling roughly every few orbits', 'Flat total energy while positions diverge'],
    build: threeBodyChaos,
    camera: { focus: 'Sun', distance: 3 * AU },
    timeWarp: 20 * DAY,
    overlays: ['vectors', 'lyapunov'],
  },
  {
    id: 'orbital-hohmann',
    name: 'Orbital Mechanics 101 — Hohmann Transfer',
    category: 'orbital',
    blurb: 'A satellite raises its orbit from LEO to geostationary altitude with one burn.',
    lesson:
      'The most fuel-efficient way between two circular orbits is a Hohmann transfer: one prograde burn at perigee to raise apogee, a coast for half the transfer ellipse, then a second burn at apogee to circularise. Total budget from 400 km to 35 786 km: 3.90 km/s. The reference GEO marker sits in the 42 164 km orbit whose period equals Earth\u2019s rotation.',
    watchFor: ['Kepler\u2019s third law: a = 26 000 km gives T ≈ 12 h', 'Perigee speed exceeding the local circular speed'],
    build: hohmannLab,
    camera: { focus: 'Earth', distance: 6e7 },
    timeWarp: 300,
    overlays: ['vectors', 'kepler'],
  },
  {
    id: 'orbital-assist',
    name: 'Gravity Assist — The Jupiter Slingshot',
    category: 'orbital',
    blurb: 'Steal orbital energy from a planet: the Voyager trick, in real numbers.',
    lesson:
      'A spacecraft cannot gain energy from a planet — but it can trade momentum with one. Approaching Jupiter at 6 km/s relative and leaving at 20 km/s is possible because the encounter rotates the velocity vector in Jupiter\u2019s frame while Jupiter\u2019s own orbital motion adds to it. Momentum is strictly conserved: Jupiter slows by about a centimetre per second.',
    watchFor: ['Speed vs. the Sun before and after closest approach', 'The velocity vector rotating but keeping its length in Jupiter\u2019s frame'],
    build: gravityAssistLab,
    camera: { focus: 'Jupiter', distance: 4e9 },
    timeWarp: 6 * 3600,
    overlays: ['vectors', 'trails'],
  },
  {
    id: 'roche-ring',
    name: 'Roche Limit — A Moon Becomes a Ring',
    category: 'extreme',
    blurb: 'Cross the tidal destruction radius and disintegrate into a ring system.',
    lesson:
      'The Roche limit d ≈ 2.44 R (ρ_M/ρ_m)^{1/3} is where a fluid satellite\u2019s own gravity can no longer resist the primary\u2019s tides. Saturn\u2019s rings are inside this radius, which is why they never coalesce. Here a moon on an eccentric orbit dips inside the limit at periapsis and is converted into a debris ring whose particles then obey N-body plus drag physics.',
    watchFor: ['Approaching the 1.8 R_M boundary at periapsis', 'The ring spreading in radius as it shears differentially'],
    build: rocheLab,
    camera: { focus: 'gas giant', distance: 3.2e8 },
    timeWarp: 4000,
    overlays: ['roche', 'vectors'],
  },
  {
    id: 'tidal-heating',
    name: 'Tidal Heating — Io and Jupiter',
    category: 'extreme',
    blurb: 'Why Io is the most volcanic body in the solar system.',
    lesson:
      'Io\u2019s eccentricity would decay in a few hundred thousand years if it were alone — but its 4:2:1 Laplace resonance with Europa and Ganymede pumps it back continuously. The resulting dissipation, (21/2)(k₂/Q)GM²R⁵ne²/a⁶, is of order 10¹⁴ W: a hundred terawatts melting its interior and driving 400 active volcanoes. Compare the tidal heating figure for Io with Callisto, outside the resonance.',
    watchFor: ['Io\u2019s tidal heating (≈10¹⁴ W) versus Callisto\u2019s', 'Surface temperature rising above radiative equilibrium'],
    build: tidalHeatingLab,
    camera: { focus: 'Jupiter', distance: 3e9 },
    timeWarp: 200,
    overlays: ['vectors', 'habitable'],
    params: { tidalPhysics: true },
  },
  {
    id: 'tde',
    name: 'Tidal Disruption Event',
    category: 'extreme',
    blurb: 'A star wanders too close to a 10⁷ M☉ black hole and is spaghettified.',
    lesson:
      'A star is held together by its own gravity; a black hole pulls harder on the near side than the far side. When the difference exceeds self-gravity, at R_tidal ≈ R_★(M_BH/m_★)^{1/3}, the star is stretched into a stream. Half the debris is flung out, half falls back to form a transient accretion disk — the flares we now detect as TDEs, roughly once every 10 000 years per galaxy.',
    watchFor: ['Periapsis falling below the tidal radius', 'The debris stream shearing into a disk'],
    build: tdeLab,
    camera: { focus: 'Supermassive black hole', distance: 8e10 },
    timeWarp: 20000,
    overlays: ['vectors', 'lens'],
    params: { relativity: true, frameDragging: true, softening: 1e8 },
  },
  {
    id: 'galaxy-curve',
    name: 'Dark Matter — Galaxy Rotation Curves',
    category: 'galactic',
    blurb: 'Observed flat rotation curves versus the Keplerian decline gravity predicts.',
    lesson:
      'The orbital speed of a star at radius r should follow v = √(GM(<r)/r): a Keplerian decline beyond the visible mass. Rubin and Ford measured flat curves in the 1970s, and the standard explanation is a halo of unseen mass. Switch the halo on in the physics panel and watch the outer stars stop slowing down. The NFW profile M(<r) = 4πρ₀r_s³[ln(1+r/r_s) − r_s/(r+r_s)] gives v ≈ constant out to hundreds of kiloparsecs.',
    watchFor: ['Speed at 5 kpc versus 20 kpc, halo off and on', 'The rotation curve plot in the telemetry panel'],
    build: () => galaxyLab(false),
    camera: { focus: 'Galactic bulge', distance: 1.2e21, elevation: 0.5 },
    timeWarp: 3e15,
    overlays: ['vectors'],
    params: { halo: 'nfw', haloMass: 1.2e12, haloScaleRadius: 3.086e20, softening: 3e17, collisionMode: 'none' },
  },
  {
    id: 'stellar-collapse',
    name: 'Core Collapse — Supernova to Black Hole',
    category: 'extreme',
    blurb: 'Push a 25 M☉ star past its limits and watch what it leaves behind.',
    lesson:
      'Stellar remnants are decided by mass alone. Below the Chandrasekhar limit (1.44 M☉) electron degeneracy pressure holds a white dwarf up. Between there and the Tolman-Oppenheimer-Volkoff limit (≈2.17 M☉) neutron degeneracy holds a neutron star. Above it, nothing known can resist: the core collapses to a Kerr black hole and the envelope is ejected at 10⁴ km/s, radiating ~10⁴⁴ J — briefly outshining its galaxy. Press "Collapse star now" in the inspector.',
    watchFor: ['The remnant type changing with mass in the inspector', 'The companion\u2019s orbit not changing at all (Birkhoff\u2019s theorem)'],
    build: collapseLab,
    camera: { focus: 'Betelgeuse-class star', distance: 40 * AU },
    timeWarp: 30 * DAY,
    overlays: ['vectors', 'kepler'],
  },
  {
    id: 'sun-black-hole',
    name: 'What If: The Sun Became a Black Hole?',
    category: 'solar',
    blurb: 'Same mass, same position — the planets keep orbiting. Only the light stops.',
    lesson:
      'A black hole of one solar mass has a Schwarzschild radius of 2.95 km: the entire Sun squeezed inside a small city, with nothing else changed. Every planet continues on exactly the same orbit, because a spherically symmetric gravitational field depends on mass, not on how that mass is distributed. The only difference is that the Sun stops shining, and Earth\u2019s surface temperature collapses toward 40 K within a couple of years.',
    watchFor: ['Identical orbital elements before and after', 'Earth\u2019s temperature falling after the light goes out'],
    build: sunToBlackHole,
    camera: { focus: 'Sun (same mass)', distance: 1.6 * AU },
    timeWarp: 4 * DAY,
    overlays: ['lens', 'vectors'],
    params: { softening: 1e6 },
  },
  {
    id: 'impact',
    name: 'What If: Chicxulub Impact',
    category: 'extreme',
    blurb: 'A 12 km asteroid at 20 km/s — 10¹⁵ kg, 2×10²³ joules.',
    lesson:
      'The shock energy Q = ½μΔv² with the reduced mass μ = m₁m₂/(m₁+m₂) works out to about 2×10²³ J, a hundred trillion tonnes of TNT. The merged Earth gains the asteroid\u2019s momentum (which is why Earth\u2019s orbit shifts by a few metres) and its surface temperature spikes; the debris that escapes the gravity well follows a power-law size distribution, dN/dm ∝ m^-1.8.',
    watchFor: ['Surface temperature spike in the Earth inspector', 'The debris swarm expanding ballistically'],
    build: impactLab,
    camera: { focus: 'Earth', distance: 8e8 },
    timeWarp: 4000,
    overlays: ['vectors', 'trails'],
  },
  {
    id: 'binary',
    name: 'Binary Star with a Circumbinary Planet',
    category: 'solar',
    blurb: 'Two stars, one barycentre, and a planet orbiting both.',
    lesson:
      'In a binary, both stars orbit the shared barycentre — the more massive star moves less. The P-type (circumbinary) orbit of Kepler-16b is stable only beyond about 3–4 times the stellar separation, because inside that radius the planet\u2019s orbit is resonantly pumped until it is ejected.',
    watchFor: ['The barycentre marker staying inside the more massive star', 'The planet\u2019s wobbling radial velocity'],
    build: binaryStarLab,
    camera: { focus: 'Primary (1.1 M☉)', distance: 4 * AU },
    timeWarp: 10 * DAY,
    overlays: ['vectors', 'kepler'],
  },
  {
    id: 'sandbox',
    name: 'Blank Sandbox',
    category: 'sandbox',
    blurb: 'The Sun and Earth, and full creative freedom.',
    lesson:
      'Everything in the library can be reached from here: spawn bodies, drag them, throw them, change the gravitational constant, add a dark-matter halo, collapse a star. Good starting points: set G to 2 and see how the year changes (T ∝ 1/√G); or pull the Moon out of Earth\u2019s Hill sphere and watch it become a planet.',
    watchFor: ['The relationship T = 2π√(a³/GM) as you change G'],
    build: sandbox,
    camera: { focus: 'Sun', distance: 3 * AU },
    timeWarp: 6 * 3600,
    overlays: ['vectors'],
  },
];

export const PRESET_CATEGORIES: { id: Preset['category']; label: string; blurb: string }[] = [
  { id: 'solar', label: 'Solar Systems', blurb: 'Real orbital elements and physical data' },
  { id: 'chaos', label: 'Three-Body & Chaos', blurb: 'Deterministic unpredictability' },
  { id: 'orbital', label: 'Orbital Mechanics 101', blurb: 'Transfers, assists and escape' },
  { id: 'extreme', label: 'Extreme Physics', blurb: 'Tides, collapse and relativistic destruction' },
  { id: 'galactic', label: 'Dark Matter & Galaxies', blurb: 'Rotation curves and halos' },
  { id: 'sandbox', label: 'Sandbox', blurb: 'Free play' },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
