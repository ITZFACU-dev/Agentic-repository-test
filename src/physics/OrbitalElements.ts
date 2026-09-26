/**
 * Keplerian orbital elements from a Cartesian state vector.
 *
 * The standard two-body reduction: given the relative position r and velocity v
 * of a secondary with respect to its primary, the specific angular momentum
 * h = r × v, the eccentricity vector e = (v × h)/μ − r̂, and the orbital
 * elements follow directly. Everything is in SI and angles are radians.
 *
 *   a  semi-major axis         = −μ / (2ε),   ε = v²/2 − μ/r   (vis-viva)
 *   e  eccentricity            = |e|
 *   i  inclination             = acos(h_z / |h|)
 *   Ω  longitude of ascending node
 *   ω  argument of periapsis
 *   ν  true anomaly
 *   T  period                  = 2π √(a³/μ)                    (Kepler III)
 */

import type { Vec3 } from '../core/mathx';

export interface OrbitalElements {
  /** Semi-major axis, m (negative for hyperbolic orbits). */
  a: number;
  /** Eccentricity. */
  e: number;
  /** Inclination, rad. */
  i: number;
  /** Longitude of the ascending node, rad. */
  ascendingNode: number;
  /** Argument of periapsis, rad. */
  argPeriapsis: number;
  /** True anomaly, rad. */
  trueAnomaly: number;
  /** Orbital period, s (Infinity when unbound). */
  period: number;
  /** Periapsis distance, m. */
  periapsis: number;
  /** Apoapsis distance, m (Infinity when unbound). */
  apoapsis: number;
  /** Specific orbital energy, J/kg. */
  specificEnergy: number;
  /** Specific angular momentum, m²/s. */
  angularMomentum: number;
  /** Current separation, m. */
  distance: number;
  /** Relative speed, m/s. */
  speed: number;
  /** Semi-latus rectum p = a(1−e²), m. */
  semiLatusRectum: number;
  /** Vis-viva prediction of the circular speed at the current radius. */
  circularSpeed: number;
  /** Local escape speed, m/s. */
  escapeSpeed: number;
  /** Mean motion n, rad/s. */
  meanMotion: number;
  /** True if the orbit is bound (ε < 0). */
  bound: boolean;
  /** Orbital plane normal (unit vector). */
  normal: Vec3;
}

const EPS = 1e-12;

export function orbitalElements(rVec: Vec3, vVec: Vec3, muPrimary: number): OrbitalElements {
  const [rx, ry, rz] = rVec;
  const [vx, vy, vz] = vVec;
  const r = Math.hypot(rx, ry, rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  const speed = Math.sqrt(v2);

  // Specific angular momentum h = r × v
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);

  // Specific orbital energy (vis-viva)
  const energy = 0.5 * v2 - muPrimary / Math.max(r, EPS);
  const bound = energy < 0;
  const a = bound ? -muPrimary / (2 * energy) : -muPrimary / (2 * energy);

  // Eccentricity vector e = (v × h)/μ − r̂
  const mx = vy * hz - vz * hy;
  const my = vz * hx - vx * hz;
  const mz = vx * hy - vy * hx;
  const ex = mx / muPrimary - rx / Math.max(r, EPS);
  const ey = my / muPrimary - ry / Math.max(r, EPS);
  const ez = mz / muPrimary - rz / Math.max(r, EPS);
  const e = Math.hypot(ex, ey, ez);

  const i = Math.acos(clampUnit(hz / Math.max(h, EPS)));

  // Node vector n = ẑ × h
  const nx = -hy;
  const ny = hx;
  const n = Math.hypot(nx, ny);
  let ascendingNode = 0;
  if (n > EPS) {
    ascendingNode = Math.acos(clampUnit(nx / n));
    if (ny < 0) ascendingNode = 2 * Math.PI - ascendingNode;
  }

  let argPeriapsis = 0;
  if (n > EPS && e > EPS) {
    argPeriapsis = Math.acos(clampUnit((nx * ex + ny * ey) / (n * e)));
    if (ez < 0) argPeriapsis = 2 * Math.PI - argPeriapsis;
  } else if (e > EPS) {
    // Equatorial orbit: use the x-axis as the reference direction.
    argPeriapsis = Math.acos(clampUnit(ex / e));
    if (ey < 0) argPeriapsis = 2 * Math.PI - argPeriapsis;
  }

  let trueAnomaly = 0;
  if (e > EPS) {
    trueAnomaly = Math.acos(clampUnit((ex * rx + ey * ry + ez * rz) / (e * r)));
    if (rx * vx + ry * vy + rz * vz < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
  } else {
    // Circular: use the argument of latitude.
    if (n > EPS) {
      trueAnomaly = Math.acos(clampUnit((nx * rx + ny * ry) / (n * r)));
      if (rz < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
    }
  }

  const periapsis = e < 1 ? a * (1 - e) : (h * h) / muPrimary / (1 + e);
  const apoapsis = e < 1 ? a * (1 + e) : Infinity;
  const period = bound ? 2 * Math.PI * Math.sqrt(a ** 3 / muPrimary) : Infinity;
  const meanMotion = bound ? Math.sqrt(muPrimary / a ** 3) : 0;

  return {
    a,
    e,
    i,
    ascendingNode,
    argPeriapsis,
    trueAnomaly,
    period,
    periapsis,
    apoapsis,
    specificEnergy: energy,
    angularMomentum: h,
    distance: r,
    speed,
    semiLatusRectum: (h * h) / muPrimary,
    circularSpeed: Math.sqrt(muPrimary / Math.max(r, EPS)),
    escapeSpeed: Math.sqrt((2 * muPrimary) / Math.max(r, EPS)),
    meanMotion,
    bound,
    normal: [hx / Math.max(h, EPS), hy / Math.max(h, EPS), hz / Math.max(h, EPS)],
  };
}

/** Solve Kepler's equation M = E − e sin E by Newton iteration. */
export function solveKepler(meanAnomaly: number, e: number): number {
  let m = meanAnomaly % (2 * Math.PI);
  if (m < 0) m += 2 * Math.PI;
  let E = e < 0.8 ? m : Math.PI;
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

/**
 * Keplerian state vector from classical elements — the inverse of
 * `orbitalElements`, used by the "place a body on a specified orbit" tools.
 */
export function stateFromElements(
  mu: number,
  a: number,
  e: number,
  inclination: number,
  ascendingNode: number,
  argPeriapsis: number,
  trueAnomaly: number,
): { r: Vec3; v: Vec3 } {
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(trueAnomaly));
  // Perifocal frame
  const xp = r * Math.cos(trueAnomaly);
  const yp = r * Math.sin(trueAnomaly);
  const vxp = -Math.sqrt(mu / p) * Math.sin(trueAnomaly);
  const vyp = Math.sqrt(mu / p) * (e + Math.cos(trueAnomaly));
  const cw = Math.cos(argPeriapsis), sw = Math.sin(argPeriapsis);
  const cO = Math.cos(ascendingNode), sO = Math.sin(ascendingNode);
  const ci = Math.cos(inclination), si = Math.sin(inclination);
  // R = Rz(Ω) Rx(i) Rz(ω)
  const r11 = cO * cw - sO * sw * ci;
  const r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci;
  const r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si;
  const r32 = cw * si;
  return {
    r: [r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp],
    v: [r11 * vxp + r12 * vyp, r21 * vxp + r22 * vyp, r31 * vxp + r32 * vyp],
  };
}

/** Δv for a Hohmann transfer between two circular coplanar orbits. */
export function hohmannTransfer(mu: number, r1: number, r2: number) {
  const v1 = Math.sqrt(mu / r1);
  const v2 = Math.sqrt(mu / r2);
  const aT = (r1 + r2) / 2;
  const vp = Math.sqrt(mu * (2 / r1 - 1 / aT));
  const va = Math.sqrt(mu * (2 / r2 - 1 / aT));
  return {
    dv1: vp - v1,
    dv2: v2 - va,
    totalDv: Math.abs(vp - v1) + Math.abs(v2 - va),
    transferTime: Math.PI * Math.sqrt(aT ** 3 / mu),
    semiMajor: aT,
  };
}

/** Gravity-assist speed change magnitude (elastic encounter with a moving planet). */
export function gravityAssistSpeedChange(vInf: number, vPlanet: number, turnAngle: number): number {
  const vOut = Math.hypot(vInf * Math.cos(turnAngle) + vPlanet, vInf * Math.sin(turnAngle));
  const vIn = Math.hypot(vInf + vPlanet, 0);
  return vOut - vIn;
}

/**
 * Lyapunov divergence: grow a perturbation δ and track ln(δ/δ₀)/t. The slope
 * of the log-divergence curve is the largest Lyapunov exponent λ.
 */
export class LyapunovTracker {
  private logDivergence: number[] = [];
  /** Initial separation, metres. */
  readonly delta0: number;
  constructor(delta0 = 1) {
    this.delta0 = delta0;
  }
  record(separation: number, t: number): void {
    if (separation <= 0 || t <= 0) return;
    this.logDivergence.push(Math.log(separation / this.delta0) / t);
  }
  get series(): number[] {
    return this.logDivergence;
  }
  get lambda(): number {
    if (this.logDivergence.length < 2) return 0;
    return this.logDivergence[this.logDivergence.length - 1];
  }
  reset(): void {
    this.logDivergence = [];
  }
}

const clampUnit = (x: number) => (x > 1 ? 1 : x < -1 ? -1 : x);
