/**
 * CelestialBody — the physical description of every object in the simulation.
 *
 * A body is a (nearly) spherical mass lump characterised by mass, radius,
 * composition, thermal state and (optionally) an atmosphere, a magnetic field,
 * a ring system or a relativistic spin parameter. Everything else — surface
 * gravity, escape velocity, density, luminosity, equilibrium temperature,
 * Roche limits, Schwarzschild radius, moment of inertia — is *derived* from
 * those primitives by the methods below, so that a single edit (say, doubling
 * a mass) propagates consistently through the whole simulation.
 *
 * The numerical state itself lives in flat Float64Arrays inside the physics
 * worker (see PhysicsEngine.ts); `BodySpec` is the serialisable description
 * that crosses the worker boundary.
 */

import {
  AU,
  C,
  CHANDRASEKHAR_LIMIT,
  EARTH_RADIUS,
  G,
  JUPITER_MASS,
  JUPITER_RADIUS,
  SIGMA_SB,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
  TOV_LIMIT,
  blackbodyColor,
  schwarzschildRadius,
} from '../core/units';
import type { Vec3 } from '../core/mathx';
import { clamp } from '../core/mathx';

export type BodyKind =
  | 'star'
  | 'planet'
  | 'moon'
  | 'dwarf'
  | 'asteroid'
  | 'comet'
  | 'blackhole'
  | 'neutronstar'
  | 'whitedwarf'
  | 'galactic-core'
  | 'galaxy'
  | 'dark-matter-halo'
  | 'custom';

export interface Composition {
  /** Mass fractions (need not sum to 1 — normalised on read). */
  rock: number;
  water: number;
  ice: number;
  gas: number;
  metal: number;
}

export interface AtmosphereSpec {
  enabled: boolean;
  /** Scale height H in metres (density falls as exp(-h/H)). */
  scaleHeight: number;
  /** Rayleigh scattering coefficients (β_r) per RGB channel, 1/m. */
  rayleigh: Vec3;
  /** Mie scattering coefficient (β_m), 1/m. */
  mie: number;
  /** Mie anisotropy (Henyey-Greenstein g, ~0.75 for aerosols). */
  mieG: number;
  /** Optical depth multiplier — a plain "thickness" knob for the UI. */
  density: number;
  /** Faint ozone absorption tint on the blue end. */
  ozone: number;
}

export interface RingSpec {
  innerRadius: number;
  outerRadius: number;
  opacity: number;
  tilt: number;
  seed: number;
}

export interface BodySpec {
  /** Stable runtime id (index in the engine arrays). */
  id: number;
  name: string;
  kind: BodyKind;
  mass: number;
  radius: number;
  pos: Vec3;
  vel: Vec3;
  /** Normalised spin axis. */
  spinAxis: Vec3;
  /** Angular speed about the spin axis, rad/s (sign = direction). */
  spinRate: number;
  albedo: number;
  /** Greenhouse forcing factor: T_surf = T_eq · (1 + greenhouse)^(1/4). */
  greenhouse: number;
  /** Intrinsic luminosity (W) — stars, hot young planets, accretion. */
  luminosity: number;
  /** Intrinsic/internal heat flux (W) — radiogenic + tidal. */
  internalHeat: number;
  /** Surface temperature (K) as currently integrated by the thermo model. */
  surfaceTemp: number;
  /** Base colour hint for the surface shader (linear sRGB). */
  color: Vec3;
  /** Deterministic noise seed for procedural surfaces. */
  seed: number;
  composition: Composition;
  atmosphere?: AtmosphereSpec;
  rings?: RingSpec;
  /** Kerr spin parameter a* ∈ [0,1) for black holes. */
  bhSpin?: number;
  /** Magnetic dipole moment (T·m³) — drives magnetosphere / aurorae. */
  magneticMoment?: number;
  /** Body is kinematic (moved by script/UI, e.g. a camera anchor). */
  fixed?: boolean;
  /** Bodies flagged as "tracked" get full telemetry (energy, elements). */
  tracked?: boolean;
  /** Free-form educational annotation shown in the inspector. */
  note?: string;
  /** Visual-only: multiply the drawn radius (a telescope-style exaggeration). */
  visualScale?: number;
  /** Fraction of the surface covered by liquid water (drives colour + clouds). */
  waterFraction?: number;
  /** Rotation-driven oblateness (0 = sphere). */
  oblateness?: number;
}

export const DEFAULT_COMPOSITION: Composition = { rock: 0.67, water: 0, ice: 0, gas: 0.3, metal: 0.03 };

export function composition(partial: Partial<Composition>): Composition {
  return { ...DEFAULT_COMPOSITION, ...partial };
}

export function atmosphere(partial: Partial<AtmosphereSpec> = {}): AtmosphereSpec {
  // Rayleigh coefficients for a nitrogen/oxygen atmosphere at sea level
  // (Bucholtz 1995): β_r(550nm) ≈ 5.8e-6 m^-1, scaled per channel.
  return {
    enabled: true,
    scaleHeight: 8500,
    rayleigh: [5.8e-6 * 1.15, 5.8e-6 * 0.98, 5.8e-6 * 0.62],
    mie: 2.1e-5,
    mieG: 0.76,
    density: 1,
    ozone: 0.35,
    ...partial,
  };
}

// ── Mass–radius and mass–luminosity relations ─────────────────────────────────

const MS_EXPONENT = 0.8; // R ∝ M^0.8 for main-sequence stars

/**
 * Main-sequence mass–radius relation (piecewise, Tout et al. 1996 fit).
 * Returns the radius in metres for a zero-age main sequence star.
 */
export function msStarRadius(mass: number): number {
  const m = mass / SOLAR_MASS;
  if (m < 0.1) return SOLAR_RADIUS * 0.12 * Math.pow(m / 0.1, 0.55);
  if (m < 1) return SOLAR_RADIUS * Math.pow(m, MS_EXPONENT) * (0.9 + 0.1 * m);
  if (m < 20) return SOLAR_RADIUS * Math.pow(m, 0.57);
  return 6.6 * SOLAR_RADIUS * Math.pow(m / 20, 0.4);
}

/**
 * Main-sequence mass–luminosity relation. L ∝ M^3.5 above ~0.43 M☉,
 * ∝ M^2.3 below (low-mass stars are convection-dominated and dimmer),
 * with a smooth blend.
 */
export function msStarLuminosity(mass: number): number {
  const m = mass / SOLAR_MASS;
  if (m < 0.43) return SOLAR_LUMINOSITY * 0.23 * Math.pow(m, 2.3);
  if (m < 2) return SOLAR_LUMINOSITY * Math.pow(m, 4.0);
  if (m < 20) return SOLAR_LUMINOSITY * Math.pow(m, 3.5);
  return SOLAR_LUMINOSITY * 1.4e3 * Math.pow(m / 20, 1.6);
}

/** Effective temperature implied by R and L (Stefan-Boltzmann). */
/**
 * Visual/optical thickness of an atmosphere: the altitude at which the
 * optical depth falls to ~1/e². Used by the scattering shader and by the
 * Roche-limit check so a gas giant's envelope is not treated as rock.
 */
export function atmosphereRadius(radius: number, at: AtmosphereSpec | null, densityScale = 1): number {
  if (!at || !at.enabled || at.density <= 0) return radius;
  const beta = (at.rayleigh[0] + at.rayleigh[1] + at.rayleigh[2]) / 3 + at.mie;
  if (!(beta > 0)) return radius + 3 * at.scaleHeight;
  const depth = (2 / beta) / Math.max(at.density * densityScale, 1e-6);
  return radius + Math.min(Math.max(depth, at.scaleHeight), 12 * at.scaleHeight);
}

export function effectiveTemperature(luminosity: number, radius: number): number {
  return Math.pow(luminosity / (4 * Math.PI * radius * radius * SIGMA_SB), 0.25);
}

/**
 * Radius for a degenerate/compact remnant of a given mass.
 * White dwarfs: R ∝ M^(-1/3) (inverse to intuition — more mass, smaller star).
 * Neutron stars: nearly constant ~12 km, stiffening slightly with mass.
 */
export function compactRadius(mass: number, kind: BodyKind): number {
  if (kind === 'whitedwarf') {
    // Approximate Hamada-Salpeter zero-temperature relation, scaled to
    // R ≈ 0.0126 R☉ at 0.6 M☉.
    const m = Math.max(mass / SOLAR_MASS, 0.17);
    return 9.0e6 * Math.pow(m / 0.6, -1 / 3);
  }
  if (kind === 'neutronstar') {
    const m = clamp(mass / SOLAR_MASS, 0.5, TOV_LIMIT / SOLAR_MASS);
    return 1.2e4 * (1 - 0.15 * (m - 1.4));
  }
  return 1e4;
}

/**
 * Radius for a gravity-dominated body. The rocky branch uses the
 * Valencia-type M^0.28 scaling, gas giants flatten out near ~1 R_J,
 * ice giants and dwarf planets interpolate between the two.
 */
export function radiusFromMass(mass: number, kind: BodyKind, comp?: Composition): number {
  switch (kind) {
    case 'star':
      return msStarRadius(mass);
    case 'whitedwarf':
    case 'neutronstar':
      return compactRadius(mass, kind);
    case 'blackhole':
      return schwarzschildRadius(mass);
    case 'galaxy':
    case 'dark-matter-halo':
    case 'galactic-core':
      return Math.max(1e18, 3e15 * Math.pow(mass / 1e42, 0.4));
    default:
      break;
  }
  const earths = mass / 5.97217e24;
  const rocky = EARTH_RADIUS * Math.pow(Math.max(earths, 1e-6), 0.28);
  const jovian = JUPITER_RADIUS * Math.pow(Math.max(mass / JUPITER_MASS, 1e-9), 0.04);
  const gasFrac = comp ? comp.gas / Math.max(1e-9, comp.gas + comp.rock + comp.metal + comp.water + comp.ice) : 0.3;
  const w = clamp((gasFrac - 0.25) / 0.5, 0, 1);
  const r = rocky * (1 - w) + jovian * w;
  if (kind === 'moon' || kind === 'asteroid') return Math.max(r * 0.98, 1e3);
  return Math.max(r, 200);
}

// ── Roche limits ──────────────────────────────────────────────────────────────

/**
 * Fluid (Roche) limit — the distance at which a self-gravitating *fluid*
 * satellite is torn apart by the primary's tides:
 *
 *     d ≈ 2.44 R_M (ρ_M / ρ_m)^{1/3}
 *
 * `rigid` returns the rigid-body limit (~1.26 R_M (ρ_M/ρ_m)^{1/3}) which is
 * roughly half the fluid value — used for solid asteroids and comets.
 */
export function rocheLimit(primaryMass: number, primaryRadius: number, satelliteDensity: number, rigid = false): number {
  const primaryDensity = primaryMass / ((4 / 3) * Math.PI * primaryRadius ** 3);
  const ratio = primaryDensity / Math.max(satelliteDensity, 1e-9);
  const k = rigid ? 1.26 : 2.44;
  return k * primaryRadius * Math.cbrt(Math.max(ratio, 1e-12));
}

/** Hill/Roche-lobe radius of a secondary of mass m1 orbiting a primary m2 at a. */
export function hillRadius(semiMajor: number, secondaryMass: number, primaryMass: number, eccentricity = 0): number {
  return semiMajor * (1 - eccentricity) * Math.cbrt(secondaryMass / (3 * Math.max(primaryMass, 1e-9)));
}

/** Tidal acceleration (differential gravity) across a body, m/s². */
export function tidalAcceleration(primaryMass: number, distance: number, bodyRadius: number): number {
  return (2 * G * primaryMass * bodyRadius) / distance ** 3;
}

// ── Orbital mechanics helpers used by factories ───────────────────────────────

/**
 * Fill in a circular orbit around `primary`: sets pos/vel for a given radius,
 * inclination and phase. Velocities are relative to the primary, which must be
 * added by the caller (or use `orbitAround`).
 */
export function circularVelocity(primaryMass: number, radius: number): number {
  return Math.sqrt((G * primaryMass) / radius);
}

export function orbitalPeriod(primaryMass: number, semiMajor: number): number {
  return 2 * Math.PI * Math.sqrt(semiMajor ** 3 / (G * primaryMass));
}

/** Escape velocity from the surface of a body. */
export function escapeVelocity(mass: number, radius: number): number {
  return Math.sqrt((2 * G * mass) / Math.max(radius, 1e-6));
}

/** Circular-orbit velocity placed on the XY plane. */
export function orbitState(
  primaryMass: number,
  radius: number,
  phase = 0,
  inclination = 0,
  eccentricity = 0,
  argPeriapsis = 0,
  ascendingNode = 0,
): { pos: Vec3; vel: Vec3 } {
  // Start in the perifocal frame, then rotate: ω → i → Ω.
  const rp = radius * (1 - eccentricity);
  const a = radius;
  const vp = Math.sqrt((G * primaryMass / a) * ((1 + eccentricity) / (1 - eccentricity)));
  const px = rp * Math.cos(argPeriapsis + phase);
  const py = rp * Math.sin(argPeriapsis + phase);
  const vx = -vp * Math.sin(argPeriapsis + phase);
  const vy = vp * Math.cos(argPeriapsis + phase);

  const ci = Math.cos(inclination);
  const si = Math.sin(inclination);
  const cO = Math.cos(ascendingNode);
  const sO = Math.sin(ascendingNode);
  // R = Rz(Ω) Rx(i)
  const rot = (x: number, y: number): Vec3 => [
    x * cO - y * ci * sO,
    x * sO + y * ci * cO,
    y * si,
  ];
  return { pos: rot(px, py), vel: rot(vx, vy) };
}

// ── The class ────────────────────────────────────────────────────────────────

let nextId = 1;
export const resetIdCounter = () => {
  nextId = 1;
};

export class CelestialBody {
  spec: BodySpec;

  constructor(spec: Partial<BodySpec> & { name: string }) {
    this.spec = {
      id: spec.id ?? nextId++,
      name: spec.name,
      kind: spec.kind ?? 'planet',
      mass: spec.mass ?? 5.97217e24,
      radius: spec.radius ?? radiusFromMass(spec.mass ?? 5.97217e24, spec.kind ?? 'planet', spec.composition),
      pos: spec.pos ?? [0, 0, 0],
      vel: spec.vel ?? [0, 0, 0],
      spinAxis: spec.spinAxis ?? [0, 0, 1],
      spinRate: spec.spinRate ?? 0,
      albedo: spec.albedo ?? 0.3,
      greenhouse: spec.greenhouse ?? 0,
      luminosity: spec.luminosity ?? 0,
      internalHeat: spec.internalHeat ?? 0,
      surfaceTemp: spec.surfaceTemp ?? 288,
      color: spec.color ?? [0.5, 0.5, 0.55],
      seed: spec.seed ?? Math.floor(Math.random() * 1e6),
      composition: spec.composition ?? composition({}),
      atmosphere: spec.atmosphere,
      rings: spec.rings,
      bhSpin: spec.bhSpin,
      magneticMoment: spec.magneticMoment,
      fixed: spec.fixed,
      tracked: spec.tracked,
      note: spec.note,
      visualScale: spec.visualScale ?? 1,
      waterFraction: spec.waterFraction ?? 0,
      oblateness: spec.oblateness ?? 0,
    };
    if (this.spec.kind === 'star' && !spec.luminosity) {
      this.spec.luminosity = msStarLuminosity(this.spec.mass);
    }
  }

  // ── Derived physical quantities ────────────────────────────────────────────
  get mass() {
    return this.spec.mass;
  }
  get radius() {
    return this.spec.radius;
  }
  get density() {
    return this.spec.mass / ((4 / 3) * Math.PI * this.spec.radius ** 3);
  }
  get volume() {
    return (4 / 3) * Math.PI * this.spec.radius ** 3;
  }
  /** Surface gravity, m/s². */
  get surfaceGravity() {
    return (G * this.spec.mass) / this.spec.radius ** 2;
  }
  get escapeVelocity() {
    return escapeVelocity(this.spec.mass, this.spec.radius);
  }
  /** Moment of inertia (uniform sphere × k, k≈0.33 rocky, 0.25 gas giant). */
  get momentOfInertia() {
    const k = this.isGaseous ? 0.25 : 0.33;
    return k * this.spec.mass * this.spec.radius ** 2;
  }
  get angularMomentum() {
    return this.momentOfInertia * this.spec.spinRate;
  }
  get isGaseous() {
    return this.spec.composition.gas > 0.4;
  }
  get isCompact() {
    return (
      this.spec.kind === 'blackhole' ||
      this.spec.kind === 'neutronstar' ||
      this.spec.kind === 'whitedwarf'
    );
  }
  /** Schwarzschild radius (m) — 2GM/c². */
  get schwarzschildRadius() {
    return schwarzschildRadius(this.spec.mass);
  }
  /** Photon sphere = 1.5 R_s. */
  get photonSphere() {
    return 1.5 * this.schwarzschildRadius;
  }
  /** Critical impact parameter for photon capture, (3√3/2) R_s. */
  get criticalB() {
    return (3 * Math.sqrt(3) / 2) * this.schwarzschildRadius;
  }
  /** Whether the object is inside its own Schwarzschild radius. */
  get isHorizonEnclosed() {
    return this.spec.radius <= this.schwarzschildRadius * 1.0001;
  }
  /** Peak wavelength of the thermal spectrum (Wien), metres. */
  get wienPeak() {
    return 2.8977719e-3 / Math.max(this.spec.surfaceTemp, 1);
  }
  get blackbodyColor(): Vec3 {
    return blackbodyColor(this.spec.surfaceTemp);
  }
  /** Radiated power from the surface (Stefan-Boltzmann) — includes internal heat. */
  get radiatedPower() {
    return 4 * Math.PI * this.spec.radius ** 2 * SIGMA_SB * this.spec.surfaceTemp ** 4;
  }
  /** Bond albedo-weighted equilibrium temperature at a given stellar flux. */
  equilibriumTemperature(flux: number): number {
    const absorbed = flux * (1 - this.spec.albedo);
    const t = Math.pow(absorbed / (4 * SIGMA_SB), 0.25);
    return t * Math.pow(1 + this.spec.greenhouse, 0.25);
  }
  /** Time to radiate away the current thermal energy (Kelvin-Helmholtz style). */
  get thermalTimescale() {
    const cpRock = 800; // J/kg/K
    const energy = this.spec.mass * cpRock * this.spec.surfaceTemp;
    return energy / Math.max(this.radiatedPower + this.spec.internalHeat, 1e-3);
  }
  /** Escape parameter: surface escape velocity in units of c. */
  get compactness() {
    return this.escapeVelocity / C;
  }
  get isRelativistic() {
    return this.compactness > 0.05;
  }

  // ── Mutations with automatic consistency ───────────────────────────────────
  /** Change mass and re-derive radius/luminosity for the body type. */
  setMass(mass: number, keepRadius = false) {
    this.spec.mass = Math.max(mass, 1);
    if (!keepRadius) {
      this.spec.radius = radiusFromMass(this.spec.mass, this.spec.kind, this.spec.composition);
    }
    if (this.spec.kind === 'star') this.spec.luminosity = msStarLuminosity(this.spec.mass);
  }

  /** Promote/demote a body when its mass crosses an astrophysical limit. */
  classifyFromMass(): { changed: boolean; from: BodyKind; to: BodyKind } {
    const kind = this.spec.kind;
    const m = this.spec.mass;
    if (kind === 'star' && m > 20 * SOLAR_MASS) {
      // Very massive stars are Wolf-Rayet-like: unchanged kind, huge L.
      this.spec.luminosity = msStarLuminosity(m);
    }
    return { changed: false, from: kind, to: kind };
  }

  /** Which remnant this body leaves behind when its nuclear fuel is exhausted. */
  remnantKind(): BodyKind {
    const m = this.spec.mass;
    if (m < CHANDRASEKHAR_LIMIT) return 'whitedwarf';
    if (m < TOV_LIMIT) return 'neutronstar';
    return 'blackhole';
  }

  clone(nameSuffix = ' copy'): CelestialBody {
    return new CelestialBody({ ...this.spec, name: this.spec.name + nameSuffix, id: nextId++ });
  }

  /** Distance to another body in metres. */
  distanceTo(other: CelestialBody | { spec: BodySpec }): number {
    const a = this.spec.pos;
    const b = other.spec.pos;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /** Convenience positional helpers in AU (for authoring presets). */
  static auPos(x: number, y: number, z = 0): Vec3 {
    return [x * AU, y * AU, z * AU];
  }
}

// ── Convenience factories used by presets and the sandbox tools ───────────────

export interface StarOptions {
  name?: string;
  mass?: number;
  luminosity?: number;
  radius?: number;
  pos?: Vec3;
  vel?: Vec3;
  temp?: number;
  color?: Vec3;
  note?: string;
  spinRate?: number;
  spinAxis?: Vec3;
}

export function makeStar(opts: StarOptions = {}): BodySpec {
  const mass = opts.mass ?? SOLAR_MASS;
  const luminosity = opts.luminosity ?? msStarLuminosity(mass);
  const radius = opts.radius ?? msStarRadius(mass);
  const temp = opts.temp ?? effectiveTemperature(luminosity, radius);
  return {
    id: 0,
    name: opts.name ?? 'Star',
    kind: 'star',
    mass,
    radius,
    pos: opts.pos ?? [0, 0, 0],
    vel: opts.vel ?? [0, 0, 0],
    spinAxis: opts.spinAxis ?? [0, 0, 1],
    spinRate: opts.spinRate ?? 2.5e-6,
    albedo: 0,
    greenhouse: 0,
    luminosity,
    internalHeat: 0,
    surfaceTemp: temp,
    color: opts.color ?? blackbodyColor(temp),
    seed: 12345,
    composition: composition({ gas: 0.98, metal: 0.02, rock: 0 }),
    note: opts.note,
    tracked: true,
  };
}

export interface PlanetOptions {
  name?: string;
  mass?: number;
  radius?: number;
  pos?: Vec3;
  vel?: Vec3;
  composition?: Partial<Composition>;
  albedo?: number;
  greenhouse?: number;
  atmosphere?: AtmosphereSpec;
  rings?: RingSpec;
  color?: Vec3;
  seed?: number;
  note?: string;
  waterFraction?: number;
  oblateness?: number;
  spinRate?: number;
  spinAxis?: Vec3;
  internalHeat?: number;
  magneticMoment?: number;
  surfaceTemp?: number;
  luminosity?: number;
  kind?: BodyKind;
}

export function makePlanet(opts: PlanetOptions = {}): BodySpec {
  const comp = composition(opts.composition ?? {});
  const mass = opts.mass ?? 5.97217e24;
  const radius = opts.radius ?? radiusFromMass(mass, 'planet', comp);
  return {
    id: 0,
    name: opts.name ?? 'Planet',
    kind: opts.kind ?? 'planet',
    mass,
    radius,
    pos: opts.pos ?? [0, 0, 0],
    vel: opts.vel ?? [0, 0, 0],
    spinAxis: opts.spinAxis ?? [0, 0, 1],
    spinRate: opts.spinRate ?? 7.2921e-5,
    albedo: opts.albedo ?? 0.3,
    greenhouse: opts.greenhouse ?? 0,
    luminosity: opts.luminosity ?? 0,
    internalHeat: opts.internalHeat ?? 0,
    surfaceTemp: opts.surfaceTemp ?? 250,
    color: opts.color ?? [0.45, 0.42, 0.38],
    seed: opts.seed ?? ((opts.name?.length ?? 3) * 7919 + 13) % 65536,
    composition: comp,
    atmosphere: opts.atmosphere,
    rings: opts.rings,
    magneticMoment: opts.magneticMoment,
    waterFraction: opts.waterFraction ?? 0,
    oblateness: opts.oblateness ?? 0,
    note: opts.note,
    tracked: true,
  };
}

export function makeBlackHole(opts: { name?: string; mass?: number; spin?: number; pos?: Vec3; vel?: Vec3; note?: string } = {}): BodySpec {
  const mass = opts.mass ?? 10 * SOLAR_MASS;
  return {
    id: 0,
    name: opts.name ?? 'Black Hole',
    kind: 'blackhole',
    mass,
    radius: schwarzschildRadius(mass),
    pos: opts.pos ?? [0, 0, 0],
    vel: opts.vel ?? [0, 0, 0],
    spinAxis: [0, 0, 1],
    spinRate: 0,
    albedo: 0,
    greenhouse: 0,
    luminosity: 0,
    internalHeat: 0,
    surfaceTemp: 0,
    color: [0, 0, 0],
    seed: 7,
    composition: composition({ rock: 0, gas: 0, metal: 0 }),
    bhSpin: opts.spin ?? 0.6,
    note: opts.note,
    tracked: true,
  };
}
