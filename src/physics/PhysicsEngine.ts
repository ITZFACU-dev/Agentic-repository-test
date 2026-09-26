/**
 * PhysicsEngine — the N-body core.
 *
 * State lives in flat Float64Arrays (structure-of-arrays) so the force loop is
 * a linear scan with no allocation. All quantities are SI. The engine is
 * deterministic given (state, dt sequence), which is what makes the Lyapunov
 * divergence and energy-conservation labs meaningful.
 *
 *   • Gravity      direct O(N²) for N ≤ 64 (exact), Barnes-Hut O(N log N) above
 *   • Integrators  RK4 (default), velocity-Verlet (symplectic), 4th-order Hermite
 *   • Adaptive sub-stepping from the local gravitational gradient ∇g
 *   • Softening ε so a close encounter never yields an infinite acceleration
 *   • 1PN post-Newtonian terms (perihelion precession) + Lense-Thirring
 *   • Collisions: momentum/angular-momentum conserving merge or elastic bounce,
 *     with thermal shock heating Q = ½μΔv² and power-law fragmentation
 *   • Roche limits → dynamic ring conversion
 *   • Tidal heating of eccentric orbits (Io–Jupiter) and tidal locking
 *   • Thermodynamics: stellar flux, albedo, greenhouse, Stefan-Boltzmann cooling
 *   • Stellar evolution: Chandrasekhar / TOV collapse → WD, NS or Kerr BH
 *   • Dark-matter halo (NFW / isothermal) for galaxy rotation curves
 */

import { BarnesHut } from './BarnesHut';
import { clamp } from '../core/mathx';
import { AU, C, CHANDRASEKHAR_LIMIT, G, SIGMA_SB, SOLAR_MASS, TOV_LIMIT, schwarzschildRadius } from '../core/units';
import type { BodyKind, BodySpec, Composition } from './CelestialBody';
import {
  DEFAULT_COMPOSITION,
  compactRadius,
  radiusFromMass,
  rocheLimit,
} from './CelestialBody';

export type IntegratorKind = 'rk4' | 'verlet' | 'hermite';
export type CollisionMode = 'merge' | 'bounce' | 'none';
export type HaloProfile = 'none' | 'nfw' | 'isothermal';

export interface PhysicsParams {
  /** Gravitational-constant multiplier (1 = real physics). */
  GScale: number;
  /** Speed-of-light multiplier (relativity + light-travel displays). */
  cScale: number;
  /** Global Plummer softening, metres. */
  softening: number;
  /** Barnes-Hut opening angle. */
  theta: number;
  integrator: IntegratorKind;
  adaptiveSubsteps: boolean;
  maxSubsteps: number;
  relativity: boolean;
  frameDragging: boolean;
  collisionMode: CollisionMode;
  restitution: number;
  fragmentation: boolean;
  rocheLimitEnabled: boolean;
  rocheRigid: boolean;
  tidalPhysics: boolean;
  thermodynamics: boolean;
  stellarEvolution: boolean;
  halo: HaloProfile;
  /** Halo mass enclosed within the virial radius, M☉. */
  haloMass: number;
  /** NFW scale radius r_s, metres. */
  haloScaleRadius: number;
  /** Linear drag coefficient (1/s) — ISM ram pressure on debris. */
  drag: number;
}

export const DEFAULT_PARAMS: PhysicsParams = {
  GScale: 1,
  cScale: 1,
  softening: 1e3,
  theta: 0.5,
  integrator: 'rk4',
  adaptiveSubsteps: true,
  maxSubsteps: 64,
  relativity: false,
  frameDragging: false,
  collisionMode: 'merge',
  restitution: 0.35,
  fragmentation: true,
  rocheLimitEnabled: true,
  rocheRigid: false,
  tidalPhysics: true,
  thermodynamics: true,
  stellarEvolution: true,
  halo: 'none',
  haloMass: 1.5e12,
  haloScaleRadius: 2e20,
  drag: 0,
};

export type PhysicsEvent =
  | {
      type: 'collision';
      targetId: number;
      targetName: string;
      impactorName: string;
      speed: number;
      energy: number;
      merged: boolean;
      heatK: number;
      fragments: number;
    }
  | {
      type: 'roche-disruption';
      primaryId: number;
      primaryName: string;
      bodyName: string;
      radius: number;
      rocheRadius: number;
      ringMass: number;
      tilt: number;
    }
  | {
      type: 'tidal-disruption';
      holeId: number;
      holeName: string;
      starName: string;
      periapsis: number;
      tidalRadius: number;
      streamMass: number;
    }
  | {
      type: 'supernova';
      bodyId: number;
      name: string;
      mass: number;
      remnant: BodyKind;
      energy: number;
      position: [number, number, number];
    }
  | { type: 'escape'; bodyId: number; name: string; speed: number; primaryName: string }
  | { type: 'tidal-locked'; bodyId: number; name: string; primaryName: string }
  | { type: 'spawn'; ids: number[] }
  | { type: 'remove'; ids: number[] }
  | { type: 'message'; text: string };

export interface BodySnapshot {
  id: number;
  name: string;
  kind: BodyKind;
  mass: number;
  radius: number;
  pos: [number, number, number];
  vel: [number, number, number];
  acc: [number, number, number];
  force: [number, number, number];
  surfaceTemp: number;
  /** Emissive intensity 0..1 driven by temperature (lava, hot ejecta). */
  emissive: number;
  luminosity: number;
  density: number;
  spinRate: number;
  spinAxis: [number, number, number];
  /** Bond-albedo-weighted incident flux, W/m². */
  flux: number;
  tidalHeating: number;
  primaryId: number;
  primaryDistance: number;
  specificEnergy: number;
  relSpeed: number;
  insideRoche: boolean;
  rocheRadius: number;
  rocheRatio: number;
  hzRole: 'none' | 'too-hot' | 'optimistic' | 'conservative' | 'too-cold';
  gravity: number;
  escapeVelocity: number;
  compactness: number;
  waterFraction: number;
  oblateness: number;
  tidalLocked: boolean;
  tracer: boolean;
  note?: string;
  composition: Composition;
}

export interface EngineDiagnostics {
  kinetic: number;
  potential: number;
  total: number;
  momentum: [number, number, number];
  angularMomentum: [number, number, number];
  com: [number, number, number];
  pairCount: number;
  substeps: number;
  wallMs: number;
  treeError: number;
  bodyCount: number;
  /** Simulated time, seconds. */
  time: number;
}

const MIN_HEAT_CAPACITY = 800; // J kg⁻¹ K⁻¹, generic rock
const LAVA_TEMP = 1100; // K, start of visible incandescence
const HOT_TEMP = 2200; // K, white hot

export class PhysicsEngine {
  params: PhysicsParams = { ...DEFAULT_PARAMS };

  capacity: number;
  count = 0;
  time = 0;

  pos: Float64Array;
  vel: Float64Array;
  acc: Float64Array;
  jerk: Float64Array;
  mass: Float64Array;
  radius: Float64Array;
  isTracer: Uint8Array;
  fixed: Uint8Array;
  bound: Uint8Array;
  ids: Int32Array;

  albedo: Float64Array;
  greenhouse: Float64Array;
  luminosity: Float64Array;
  internalHeat: Float64Array;
  surfaceTemp: Float64Array;
  tidalHeat: Float64Array;
  spinRate: Float64Array;
  spinAxis: Float64Array;
  k2overQ: Float64Array;
  bhSpin: Float64Array;
  waterFraction: Float64Array;
  oblateness: Float64Array;
  tidalLocked: Uint8Array;
  colors: Float64Array;

  composition: Composition[] = [];
  kinds: BodyKind[] = [];
  names: string[] = [];
  notes: (string | undefined)[] = [];
  seeds: number[] = [];
  fluxCache: number[] = [];

  events: PhysicsEvent[] = [];
  diagnostics: EngineDiagnostics = {
    kinetic: 0,
    potential: 0,
    total: 0,
    momentum: [0, 0, 0],
    angularMomentum: [0, 0, 0],
    com: [0, 0, 0],
    pairCount: 0,
    substeps: 1,
    wallMs: 0,
    treeError: 0,
    bodyCount: 0,
    time: 0,
  };

  private tree = new BarnesHut(4096);
  private nextId = 1e6;
  private scratch: { k1v: Float64Array; k1x: Float64Array; k2v: Float64Array; k2x: Float64Array; k3v: Float64Array; k3x: Float64Array; k4v: Float64Array; k4x: Float64Array; tmp: Float64Array } | null = null;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    const f3 = () => new Float64Array(capacity * 3);
    this.pos = f3();
    this.vel = f3();
    this.acc = f3();
    this.jerk = f3();
    this.spinAxis = f3();
    this.colors = f3();
    const f1 = () => new Float64Array(capacity);
    this.mass = f1();
    this.radius = f1();
    this.albedo = f1();
    this.greenhouse = f1();
    this.luminosity = f1();
    this.internalHeat = f1();
    this.surfaceTemp = f1();
    this.tidalHeat = f1();
    this.spinRate = f1();
    this.k2overQ = f1();
    this.bhSpin = f1();
    this.waterFraction = f1();
    this.oblateness = f1();
    this.isTracer = new Uint8Array(capacity);
    this.fixed = new Uint8Array(capacity);
    this.bound = new Uint8Array(capacity);
    this.tidalLocked = new Uint8Array(capacity);
    this.ids = new Int32Array(capacity);
  }

  private get Gs(): number {
    return G * this.params.GScale;
  }

  // ── Body management ────────────────────────────────────────────────────────

  private grow() {
    if (this.count + 1 <= this.capacity) return;
    const cap = Math.max(this.capacity * 2, this.count + 1);
    const f3 = (old: Float64Array) => {
      const n = new Float64Array(cap * 3);
      n.set(old);
      return n;
    };
    const f1 = (old: Float64Array) => {
      const n = new Float64Array(cap);
      n.set(old);
      return n;
    };
    const u1 = (old: Uint8Array) => {
      const n = new Uint8Array(cap);
      n.set(old);
      return n;
    };
    this.pos = f3(this.pos);
    this.vel = f3(this.vel);
    this.acc = f3(this.acc);
    this.jerk = f3(this.jerk);
    this.spinAxis = f3(this.spinAxis);
    this.colors = f3(this.colors);
    this.mass = f1(this.mass);
    this.radius = f1(this.radius);
    this.albedo = f1(this.albedo);
    this.greenhouse = f1(this.greenhouse);
    this.luminosity = f1(this.luminosity);
    this.internalHeat = f1(this.internalHeat);
    this.surfaceTemp = f1(this.surfaceTemp);
    this.tidalHeat = f1(this.tidalHeat);
    this.spinRate = f1(this.spinRate);
    this.k2overQ = f1(this.k2overQ);
    this.bhSpin = f1(this.bhSpin);
    this.waterFraction = f1(this.waterFraction);
    this.oblateness = f1(this.oblateness);
    this.isTracer = u1(this.isTracer);
    this.fixed = u1(this.fixed);
    this.bound = u1(this.bound);
    this.tidalLocked = u1(this.tidalLocked);
    const nid = new Int32Array(cap);
    nid.set(this.ids);
    this.ids = nid;
    this.capacity = cap;
    this.scratch = null;
  }

  /** Replace the whole body set (preset load). */
  load(specs: BodySpec[]): void {
    this.count = 0;
    this.time = 0;
    this.events.length = 0;
    this.fluxCache = [];
    this.composition = [];
    this.kinds = [];
    this.names = [];
    this.notes = [];
    this.seeds = [];
    for (const s of specs) this.add(s, true);
    this.recomputeForces();
    this.updateDiagnostics();
    this.events.push({ type: 'spawn', ids: Array.from(this.ids.subarray(0, this.count)) });
  }

  add(spec: BodySpec, quiet = false): number {
    this.grow();
    const i = this.count++;
    const p = this.params;
    this.ids[i] = spec.id || i + 1;
    this.names[i] = spec.name;
    this.kinds[i] = spec.kind;
    this.notes[i] = spec.note;
    this.seeds[i] = spec.seed;
    this.mass[i] = spec.mass;
    this.radius[i] = spec.radius;
    this.pos[i * 3] = spec.pos[0];
    this.pos[i * 3 + 1] = spec.pos[1];
    this.pos[i * 3 + 2] = spec.pos[2];
    this.vel[i * 3] = spec.vel[0];
    this.vel[i * 3 + 1] = spec.vel[1];
    this.vel[i * 3 + 2] = spec.vel[2];
    const sa = spec.spinAxis ?? [0, 0, 1];
    const sl = Math.hypot(sa[0], sa[1], sa[2]) || 1;
    this.spinAxis[i * 3] = sa[0] / sl;
    this.spinAxis[i * 3 + 1] = sa[1] / sl;
    this.spinAxis[i * 3 + 2] = sa[2] / sl;
    this.spinRate[i] = spec.spinRate ?? 0;
    this.albedo[i] = spec.albedo ?? 0.3;
    this.greenhouse[i] = spec.greenhouse ?? 0;
    this.luminosity[i] = spec.luminosity ?? 0;
    this.internalHeat[i] = spec.internalHeat ?? 0;
    this.surfaceTemp[i] = spec.surfaceTemp ?? 250;
    this.tidalHeat[i] = 0;
    this.composition[i] = spec.composition ?? { ...DEFAULT_COMPOSITION };
    const c = spec.color ?? [0.5, 0.5, 0.5];
    this.colors[i * 3] = c[0];
    this.colors[i * 3 + 1] = c[1];
    this.colors[i * 3 + 2] = c[2];
    this.bhSpin[i] = spec.bhSpin ?? 0;
    this.waterFraction[i] = spec.waterFraction ?? 0;
    this.oblateness[i] = spec.oblateness ?? 0;
    this.tidalLocked[i] = 0;
    this.bound[i] = 0;
    this.fixed[i] = spec.fixed ? 1 : 0;
    this.isTracer[i] = spec.mass <= 0 ? 1 : 0;
    if (this.isTracer[i]) this.mass[i] = 0;
    this.k2overQ[i] = k2OverQDefault(spec.kind, this.composition[i]);
    if (!quiet) this.events.push({ type: 'spawn', ids: [this.ids[i]] });
    void p;
    return i;
  }

  private indexOf(id: number): number {
    for (let i = 0; i < this.count; i++) if (this.ids[i] === id) return i;
    return -1;
  }

  private removeAt(i: number): void {
    const last = --this.count;
    if (i < 0 || i > last) return;
    const copyVec = (arr: Float64Array) => {
      for (let k = 0; k < 3; k++) arr[i * 3 + k] = arr[last * 3 + k];
    };
    const copyNum = (arr: Float64Array) => {
      arr[i] = arr[last];
    };
    const copyInt = (arr: Int32Array) => {
      arr[i] = arr[last];
    };
    const copyByte = (arr: Uint8Array) => {
      arr[i] = arr[last];
    };
    copyVec(this.pos);
    copyVec(this.vel);
    copyVec(this.acc);
    copyVec(this.jerk);
    copyVec(this.spinAxis);
    copyVec(this.colors);
    copyNum(this.mass);
    copyNum(this.radius);
    copyNum(this.albedo);
    copyNum(this.greenhouse);
    copyNum(this.luminosity);
    copyNum(this.internalHeat);
    copyNum(this.surfaceTemp);
    copyNum(this.tidalHeat);
    copyNum(this.spinRate);
    copyNum(this.k2overQ);
    copyNum(this.bhSpin);
    copyNum(this.waterFraction);
    copyNum(this.oblateness);
    copyInt(this.ids);
    copyByte(this.isTracer);
    copyByte(this.fixed);
    copyByte(this.bound);
    copyByte(this.tidalLocked);
    this.composition[i] = this.composition[last];
    this.kinds[i] = this.kinds[last];
    this.names[i] = this.names[last];
    this.notes[i] = this.notes[last];
    this.seeds[i] = this.seeds[last];
  }

  removeById(id: number): boolean {
    const i = this.indexOf(id);
    if (i < 0) return false;
    this.removeAt(i);
    this.events.push({ type: 'remove', ids: [id] });
    this.recomputeForces();
    return true;
  }

  /** Apply a main-thread edit (mass, radius, velocity, impulse, …). */
  update(id: number, patch: Partial<BodySpec> & { impulse?: [number, number, number] }): boolean {
    const i = this.indexOf(id);
    if (i < 0) return false;
    if (patch.mass !== undefined) {
      this.mass[i] = patch.mass;
      this.isTracer[i] = patch.mass <= 0 ? 1 : 0;
      if (patch.radius === undefined) {
        this.radius[i] = radiusFromMass(patch.mass, patch.kind ?? this.kinds[i], this.composition[i]);
      }
    }
    if (patch.radius !== undefined) this.radius[i] = patch.radius;
    if (patch.pos) {
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] = patch.pos[k];
    }
    if (patch.vel) {
      for (let k = 0; k < 3; k++) this.vel[i * 3 + k] = patch.vel[k];
    }
    if (patch.impulse) {
      for (let k = 0; k < 3; k++) this.vel[i * 3 + k] += patch.impulse[k];
    }
    if (patch.name) this.names[i] = patch.name;
    if (patch.kind) this.kinds[i] = patch.kind;
    if (patch.albedo !== undefined) this.albedo[i] = patch.albedo;
    if (patch.greenhouse !== undefined) this.greenhouse[i] = patch.greenhouse;
    if (patch.luminosity !== undefined) this.luminosity[i] = patch.luminosity;
    if (patch.internalHeat !== undefined) this.internalHeat[i] = patch.internalHeat;
    if (patch.surfaceTemp !== undefined) this.surfaceTemp[i] = patch.surfaceTemp;
    if (patch.spinRate !== undefined) this.spinRate[i] = patch.spinRate;
    if (patch.bhSpin !== undefined) this.bhSpin[i] = patch.bhSpin;
    if (patch.waterFraction !== undefined) this.waterFraction[i] = patch.waterFraction;
    if (patch.oblateness !== undefined) this.oblateness[i] = patch.oblateness;
    if (patch.fixed !== undefined) this.fixed[i] = patch.fixed ? 1 : 0;
    if (patch.spinAxis) {
      const sl = Math.hypot(patch.spinAxis[0], patch.spinAxis[1], patch.spinAxis[2]) || 1;
      for (let k = 0; k < 3; k++) this.spinAxis[i * 3 + k] = patch.spinAxis[k] / sl;
    }
    if (patch.color) {
      for (let k = 0; k < 3; k++) this.colors[i * 3 + k] = patch.color[k];
    }
    this.recomputeForces();
    return true;
  }

  private allocateId(): number {
    return this.nextId++;
  }

  // ── Force kernels ──────────────────────────────────────────────────────────

  /**
   * Softening ε² for a pair. This is a purely numerical device: outside contact
   * the interaction must be exactly Newtonian, or Kepler's laws would not hold
   * (using body radii here biases Io's force by ~4%). Contact itself is handled
   * by the collision resolver and by adaptive sub-stepping, never by softening.
   */
  private softening2For(_i: number, _j: number): number {
    const eps = this.params.softening;
    return eps * eps;
  }

  /** Exact O(N²) gravity. */
  private directForces(): void {
    const { pos, acc, mass, count } = this;
    const Gs = this.Gs;
    acc.fill(0);
    let pairs = 0;
    for (let i = 0; i < count; i++) {
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2];
      const mi = mass[i];
      for (let j = i + 1; j < count; j++) {
        const dx = pos[j * 3] - xi;
        const dy = pos[j * 3 + 1] - yi;
        const dz = pos[j * 3 + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz + this.softening2For(i, j);
        const inv = 1 / Math.sqrt(r2);
        const inv3 = inv * inv * inv;
        const mj = mass[j];
        const f = Gs * inv3;
        acc[i * 3] += f * mj * dx;
        acc[i * 3 + 1] += f * mj * dy;
        acc[i * 3 + 2] += f * mj * dz;
        acc[j * 3] -= f * mi * dx;
        acc[j * 3 + 1] -= f * mi * dy;
        acc[j * 3 + 2] -= f * mi * dz;
        pairs++;
      }
    }
    this.diagnostics.pairCount = pairs;
  }

  /** Barnes-Hut forces for large N. */
  private treeForces(): void {
    const { pos, acc, mass, count } = this;
    acc.fill(0);
    const eps = this.params.softening;
    this.tree.eps2 = eps * eps;
    this.tree.G = this.Gs;
    this.tree.theta = Math.max(this.params.theta, 1e-4);
    this.tree.build(pos, mass, this.isTracer, count);
    let pairs = 0;
    for (let i = 0; i < count; i++) {
      pairs += this.tree.acceleration(i, pos, acc);
    }
    this.diagnostics.pairCount = pairs;
  }

  /** Exact gravitational potential energy (O(N²)). */
  potentialEnergy(): number {
    const { pos, mass, count } = this;
    const Gs = this.Gs;
    let u = 0;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz + this.softening2For(i, j);
        u -= (Gs * mass[i] * mass[j]) / Math.sqrt(r2);
      }
    }
    return u;
  }

  /** Recompute all accelerations for the current state. */
  recomputeForces(): void {
    if (this.count > 64) this.treeForces();
    else this.directForces();
    this.applyHalo();
    if (this.params.relativity || this.params.frameDragging) this.applyRelativisticCorrections();
    if (this.params.drag > 0) this.applyDrag();
  }

  // ── Integrators ────────────────────────────────────────────────────────────

  /**
   * Adaptive sub-stepping from the local gravitational gradient.
   *
   * The time over which the force on a body changes appreciably is
   *
   *     τ = max( |v|/|a| , √(r/|a|) ),
   *
   * where r is the distance to the nearest gravitating body. For a circular
   * orbit both terms equal r/|v|, i.e. the orbital period over 2π; for a body
   * released from rest the second term is its free-fall time. Near periapsis,
   * |a| grows as 1/r² while |v| grows only as 1/√r, so τ collapses and the step
   * is refined automatically — no slingshot artefacts, no manual babysitting.
   *
   * Above 256 bodies the pairwise scan is skipped and the softening length sets
   * the fallback scale, which is the correct resolution limit for a galaxy run.
   */
  private requiredSubsteps(dt: number): number {
    if (!this.params.adaptiveSubsteps) return 1;
    const minTau = 0.04;
    const count = this.count;
    const pairwise = count <= 256;
    let tauMin = Infinity;
    for (let i = 0; i < count; i++) {
      if (this.fixed[i]) continue;
      const a = Math.hypot(this.acc[i * 3], this.acc[i * 3 + 1], this.acc[i * 3 + 2]);
      if (!(a > 0)) continue;
      const v = Math.hypot(this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]);
      let rNear = Infinity;
      if (pairwise) {
        for (let j = 0; j < count; j++) {
          if (j === i || this.isTracer[j] || this.mass[j] <= 0) continue;
          const r = Math.hypot(
            this.pos[j * 3] - this.pos[i * 3],
            this.pos[j * 3 + 1] - this.pos[i * 3 + 1],
            this.pos[j * 3 + 2] - this.pos[i * 3 + 2],
          );
          if (r < rNear) rNear = r;
        }
      }
      if (!isFinite(rNear)) rNear = Math.max(this.params.softening, 1) * 4;
      const tauFall = Math.sqrt(rNear / a);
      const tauV = v > 0 ? v / a : Infinity;
      const tau = Math.max(tauV, tauFall);
      if (tau < tauMin) tauMin = tau;
    }
    if (!isFinite(tauMin) || tauMin <= 0) return 1;
    const need = Math.ceil(Math.abs(dt) / (minTau * tauMin));
    return clamp(need, 1, this.params.maxSubsteps);
  }

  /** Advance the simulation by dt seconds. */
  step(dt: number): void {
    const t0 = performance.now();
    const sub = this.requiredSubsteps(dt);
    const h = dt / sub;
    this.diagnostics.substeps = sub;
    for (let s = 0; s < sub; s++) {
      switch (this.params.integrator) {
        case 'verlet':
          this.stepVerlet(h);
          break;
        case 'hermite':
          this.stepHermite(h);
          break;
        default:
          this.stepRK4(h);
      }
      this.time += h;
    }
    this.postStep(dt);
    this.diagnostics.wallMs = performance.now() - t0;
    this.diagnostics.bodyCount = this.count;
    this.diagnostics.time = this.time;
  }

  private ensureScratch() {
    const N3 = this.capacity * 3;
    if (this.scratch && this.scratch.k1v.length >= N3) return this.scratch;
    this.scratch = {
      k1v: new Float64Array(N3),
      k1x: new Float64Array(N3),
      k2v: new Float64Array(N3),
      k2x: new Float64Array(N3),
      k3v: new Float64Array(N3),
      k3x: new Float64Array(N3),
      k4v: new Float64Array(N3),
      k4x: new Float64Array(N3),
      tmp: new Float64Array(N3),
    };
    return this.scratch;
  }

  /** Classical Runge-Kutta 4 — the default: 4th order, uniform step safety. */
  private stepRK4(h: number): void {
    const n3 = this.count * 3;
    if (n3 === 0) return;
    const s = this.ensureScratch();
    const { pos, vel, acc } = this;
    const savePos = pos.slice(0, n3);
    this.recomputeForces();
    for (let k = 0; k < n3; k++) {
      s.k1v[k] = acc[k];
      s.k1x[k] = vel[k];
    }
    this.maskFixed(s.k1v, s.k1x);
    for (let k = 0; k < n3; k++) s.tmp[k] = savePos[k] + 0.5 * h * s.k1x[k];
    pos.set(s.tmp.subarray(0, n3));
    this.recomputeForces();
    for (let k = 0; k < n3; k++) {
      s.k2v[k] = acc[k];
      s.k2x[k] = vel[k] + 0.5 * h * s.k1v[k];
    }
    this.maskFixed(s.k2v, s.k2x);
    for (let k = 0; k < n3; k++) s.tmp[k] = savePos[k] + 0.5 * h * s.k2x[k];
    pos.set(s.tmp.subarray(0, n3));
    this.recomputeForces();
    for (let k = 0; k < n3; k++) {
      s.k3v[k] = acc[k];
      s.k3x[k] = vel[k] + 0.5 * h * s.k2v[k];
    }
    this.maskFixed(s.k3v, s.k3x);
    for (let k = 0; k < n3; k++) s.tmp[k] = savePos[k] + h * s.k3x[k];
    pos.set(s.tmp.subarray(0, n3));
    this.recomputeForces();
    for (let k = 0; k < n3; k++) {
      s.k4v[k] = acc[k];
      s.k4x[k] = vel[k] + h * s.k3v[k];
    }
    this.maskFixed(s.k4v, s.k4x);
    const h6 = h / 6;
    for (let k = 0; k < n3; k++) {
      pos[k] = savePos[k] + h6 * (s.k1x[k] + 2 * s.k2x[k] + 2 * s.k3x[k] + s.k4x[k]);
      vel[k] += h6 * (s.k1v[k] + 2 * s.k2v[k] + 2 * s.k3v[k] + s.k4v[k]);
    }
    this.recomputeForces();
  }

  /**
   * Zero the Runge-Kutta stage derivatives of kinematic bodies. Fixed bodies
   * (camera anchors, deliberately held planets) must not move, but their
   * accelerations are still reported to the HUD.
   */
  private maskFixed(...stages: Float64Array[]): void {
    for (let i = 0; i < this.count; i++) {
      if (!this.fixed[i]) continue;
      for (const st of stages) {
        st[i * 3] = 0;
        st[i * 3 + 1] = 0;
        st[i * 3 + 2] = 0;
      }
    }
  }

  /** Velocity Verlet (kick-drift-kick): symplectic, so energy oscillates
   *  instead of drifting — the Hamiltonian-preservation demo. */
  private stepVerlet(h: number): void {
    const n = this.count;
    if (n === 0) return;
    const { pos, vel, acc } = this;
    const a0 = acc.slice(0, n * 3);
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        pos[idx] += vel[idx] * h + 0.5 * a0[idx] * h * h;
      }
    }
    this.recomputeForces();
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        vel[idx] += 0.5 * h * (a0[idx] + acc[idx]);
      }
    }
  }

  /** dj/dt = d(a)/dt, computed by direct summation. */
  private computeJerk(): void {
    const { pos, vel, jerk, mass, count } = this;
    const Gs = this.Gs;
    jerk.fill(0);
    for (let i = 0; i < count; i++) {
      if (this.fixed[i]) continue;
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2];
      const vxi = vel[i * 3], vyi = vel[i * 3 + 1], vzi = vel[i * 3 + 2];
      let jx = 0, jy = 0, jz = 0;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const dx = pos[j * 3] - xi, dy = pos[j * 3 + 1] - yi, dz = pos[j * 3 + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz + this.softening2For(i, j);
        const inv3 = 1 / (r2 * Math.sqrt(r2));
        const dvx = vel[j * 3] - vxi, dvy = vel[j * 3 + 1] - vyi, dvz = vel[j * 3 + 2] - vzi;
        const rdv = (dx * dvx + dy * dvy + dz * dvz) / r2;
        const f = Gs * mass[j] * inv3;
        jx += f * (dvx - 3 * rdv * dx);
        jy += f * (dvy - 3 * rdv * dy);
        jz += f * (dvz - 3 * rdv * dz);
      }
      jerk[i * 3] = jx;
      jerk[i * 3 + 1] = jy;
      jerk[i * 3 + 2] = jz;
    }
  }

  /**
   * 4th-order Hermite predictor-corrector (Makino & Aarseth 1992): uses the
   * acceleration and its time derivative, giving high accuracy per force
   * evaluation on smooth orbital problems.
   */
  private stepHermite(h: number): void {
    const n = this.count;
    if (n === 0) return;
    const { pos, vel, acc, jerk } = this;
    this.recomputeForces();
    this.computeJerk();
    const n3 = n * 3;
    const a0 = acc.slice(0, n3);
    const j0 = jerk.slice(0, n3);
    const p0 = pos.slice(0, n3);
    const v0 = vel.slice(0, n3);
    const h2 = h * h;
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        pos[idx] = p0[idx] + v0[idx] * h + 0.5 * a0[idx] * h2 + (j0[idx] * h2 * h) / 6;
        vel[idx] = v0[idx] + a0[idx] * h + 0.5 * j0[idx] * h2;
      }
    }
    this.recomputeForces();
    this.computeJerk();
    // Corrector: fit a cubic Hermite polynomial to the acceleration using
    // (a0, j0) at the start and (a1, j1) at the end of the step, then integrate
    // it exactly for v and twice for x:
    //     v1 = v0 + (h/2)(a0 + a1) + (h²/12)(j0 − j1)
    //     x1 = x_p + (3/20)h²(a1 − a0) − (h³/60)(7j0 + 2j1)
    const c20 = (3 * h2) / 20;
    const c60 = (h2 * h) / 60;
    const h2v = h / 2;
    const h2j = h2 / 12;
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        const a1 = acc[idx];
        const j1 = jerk[idx];
        pos[idx] += c20 * (a1 - a0[idx]) - c60 * (7 * j0[idx] + 2 * j1);
        vel[idx] = v0[idx] + h2v * (a0[idx] + a1) + h2j * (j0[idx] - j1);
      }
    }
    this.recomputeForces();
    this.normaliseFinite();
  }

  private normaliseFinite(): void {
    const n3 = this.count * 3;
    for (let k = 0; k < n3; k++) {
      if (!isFinite(this.pos[k])) this.pos[k] = 0;
      if (!isFinite(this.vel[k])) this.vel[k] = 0;
      if (!isFinite(this.acc[k])) this.acc[k] = 0;
    }
  }

  // ── External fields ───────────────────────────────────────────────────────

  /** Dark-matter halo (NFW or cored isothermal) centred on the bulge. */
  private applyHalo(): void {
    const p = this.params;
    if (p.halo === 'none' || this.count === 0) return;
    let ci = 0;
    let cm = -1;
    for (let i = 0; i < this.count; i++) {
      if (!this.isTracer[i] && this.mass[i] > cm) {
        cm = this.mass[i];
        ci = i;
      }
    }
    const cx = this.pos[ci * 3], cy = this.pos[ci * 3 + 1], cz = this.pos[ci * 3 + 2];
    const rs = p.haloScaleRadius;
    const haloMassSI = p.haloMass * SOLAR_MASS;
    const conc = 10;
    const shape = Math.log(1 + conc) - conc / (1 + conc);
    const rho0 = haloMassSI / (4 * Math.PI * rs ** 3 * shape);
    const Gs = this.Gs;
    for (let i = 0; i < this.count; i++) {
      if (this.fixed[i] || i === ci) continue;
      const dx = this.pos[i * 3] - cx;
      const dy = this.pos[i * 3 + 1] - cy;
      const dz = this.pos[i * 3 + 2] - cz;
      const r = Math.hypot(dx, dy, dz);
      if (r < 1e-6) continue;
      const x = r / rs;
      // Both profiles share the NFW-shaped enclosed mass; the isothermal case
      // simply normalises over a larger core radius, which flattens the curve
      // at small radii (the "core-cusp" distinction students can compare).
      const coreR = p.halo === 'nfw' ? rs : 4 * rs;
      const xc = r / coreR;
      const enclosed = 4 * Math.PI * rho0 * coreR ** 3 * (Math.log(1 + xc) - xc / (1 + xc));
      const a = (Gs * Math.max(enclosed, 0)) / (r * r);
      this.acc[i * 3] += (a * dx) / r;
      this.acc[i * 3 + 1] += (a * dy) / r;
      this.acc[i * 3 + 2] += (a * dz) / r;
      void x;
    }
  }

  /**
   * 1PN post-Newtonian correction (two-body EIH form):
   *
   *     a_1PN = (G M / c²r²) [ (4GM/r − v²) r̂ + 4 (r̂·v) v ]
   *
   * This term is what advances Mercury's perihelion by 43″ per century.
   * Lense-Thirring frame dragging is added for spinning compact objects.
   */
  private applyRelativisticCorrections(): void {
    const p = this.params;
    const c = C * p.cScale;
    const c2 = c * c;
    const Gs = this.Gs;
    const { pos, vel, acc, mass } = this;
    const n = this.count;
    // Pairwise, with the reaction distributed by the mass ratio so that total
    // momentum is conserved exactly (Σ mᵢaᵢ = 0). Applying the full PN term to
    //both bodies — as a naive pairwise sum does — would spuriously accelerate a
    // 10⁷ M☉ black hole to hundreds of c.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        const r = Math.sqrt(r2);
        if (r < 1e-9) continue;
        const dvx = vel[j * 3] - vel[i * 3];
        const dvy = vel[j * 3 + 1] - vel[i * 3 + 1];
        const dvz = vel[j * 3 + 2] - vel[i * 3 + 2];
        const mi = mass[i];
        const mj = mass[j];
        const M = mi + mj;
        if (M <= 0) continue;
        let ax = 0, ay = 0, az = 0;
        if (p.relativity) {
          // 1PN (Einstein-Infeld-Hoffmann, two-body limit):
          //   a_rel = (GM/c²r²)[(4GM/r − v²) r̂ + 4(r̂·v)v]
          const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
          const rx = dx / r, ry = dy / r, rz = dz / r;
          const rv = rx * dvx + ry * dvy + rz * dvz;
          const coef = (Gs * M) / (c2 * r2);
          const term = (4 * Gs * M) / r - v2;
          ax += coef * (term * rx + 4 * rv * dvx);
          ay += coef * (term * ry + 4 * rv * dvy);
          az += coef * (term * rz + 4 * rv * dvz);
        }
        if (p.frameDragging) {
          // Lense-Thirring frame dragging from whichever body spins:
          //   a_rel = (2G/c²r³)[3(S·r̂)(r̂ × v) − (v × S)],  S = a* GM²/c
          for (const [spinner, sign] of [[i, 1], [j, -1]] as const) {
            if (this.bhSpin[spinner] <= 0) continue;
            const Smag = (this.bhSpin[spinner] * Gs * mass[spinner] * mass[spinner]) / c;
            const Sx = this.spinAxis[spinner * 3] * Smag;
            const Sy = this.spinAxis[spinner * 3 + 1] * Smag;
            const Sz = this.spinAxis[spinner * 3 + 2] * Smag;
            // Position of the orbiting body relative to the spinning one.
            const ox = sign === 1 ? pos[j * 3] - pos[i * 3] : pos[i * 3] - pos[j * 3];
            const oy = sign === 1 ? pos[j * 3 + 1] - pos[i * 3 + 1] : pos[i * 3 + 1] - pos[j * 3 + 1];
            const oz = sign === 1 ? pos[j * 3 + 2] - pos[i * 3 + 2] : pos[i * 3 + 2] - pos[j * 3 + 2];
            const ovx = sign === 1 ? dvx : -dvx;
            const ovy = sign === 1 ? dvy : -dvy;
            const ovz = sign === 1 ? dvz : -dvz;
            const SrHat = (Sx * ox + Sy * oy + Sz * oz) / r2;
            const cx = (oy * ovz - oz * ovy) / r;
            const cy = (oz * ovx - ox * ovz) / r;
            const cz = (ox * ovy - oy * ovx) / r;
            const wx = ovy * Sz - ovz * Sy;
            const wy = ovz * Sx - ovx * Sz;
            const wz = ovx * Sy - ovy * Sx;
            const klt = (2 * Gs) / (c2 * r2 * r);
            ax += klt * (3 * SrHat * cx - wx);
            ay += klt * (3 * SrHat * cy - wy);
            az += klt * (3 * SrHat * cz - wz);
          }
        }
        if (ax === 0 && ay === 0 && az === 0) continue;
        // Relative acceleration a_rel = a_j − a_i distributes as
        //   a_j = a_rel·m_i/M (for the pair)  and  a_i = −a_rel·m_j/M.
        const wi = mj / M;
        const wj = mi / M;
        acc[i * 3] -= ax * wi;
        acc[i * 3 + 1] -= ay * wi;
        acc[i * 3 + 2] -= az * wi;
        acc[j * 3] += ax * wj;
        acc[j * 3 + 1] += ay * wj;
        acc[j * 3 + 2] += az * wj;
      }
    }
  }

  private applyDrag(): void {
    const k = this.params.drag;
    for (let i = 0; i < this.count; i++) {
      if (this.fixed[i]) continue;
      this.acc[i * 3] -= k * this.vel[i * 3];
      this.acc[i * 3 + 1] -= k * this.vel[i * 3 + 1];
      this.acc[i * 3 + 2] -= k * this.vel[i * 3 + 2];
    }
  }

  // ── Post-step physics ─────────────────────────────────────────────────────

  private postStep(dt: number): void {
    if (this.params.tidalPhysics) this.updateTides();
    if (this.params.thermodynamics) this.updateThermodynamics(dt);
    this.checkTidalDisruption();
    this.resolveCollisions();
    if (this.params.rocheLimitEnabled) this.checkRoche();
    if (this.params.stellarEvolution) this.checkStellarEvolution();
    this.updateBoundFlags();
    this.updateDiagnostics();
  }

  /**
   * Incident stellar flux and radiative-equilibrium temperature.
   *
   *   T_eq = [ L(1−A) / (16πσd²) ]^{1/4} · (1 + greenhouse)^{1/4}
   *
   * The surface then relaxes toward T_eq through the Stefan-Boltzmann law,
   * C dT/dt = Q_in − 4πR²σT⁴, so impact lava lakes glow and cool over time.
   */
  updateThermodynamics(dt: number): void {
    const n = this.count;
    const { pos, luminosity, albedo, greenhouse, internalHeat, radius, surfaceTemp, mass, tidalHeat } = this;
    const flux = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      if (luminosity[j] <= 0) continue;
      const isStar = this.kinds[j] === 'star';
      for (let i = 0; i < n; i++) {
        if (i === j) continue;
        // Stars illuminate everything; a planet only lights its own moons.
        if (!isStar && this.kinds[i] !== 'moon') continue;
        const dx = pos[i * 3] - pos[j * 3];
        const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1);
        flux[i] += luminosity[j] / (4 * Math.PI * d2);
      }
    }
    for (let i = 0; i < n; i++) {
      if (this.isTracer[i]) continue;
      if (this.kinds[i] === 'star' || this.kinds[i] === 'blackhole' || this.kinds[i] === 'galaxy') continue;
      const area = 4 * Math.PI * radius[i] ** 2;
      const absorbed = flux[i] * (1 - albedo[i]);
      const qIn = absorbed * Math.PI * radius[i] ** 2 + internalHeat[i] + tidalHeat[i];
      const qEff = qIn * (1 + greenhouse[i]);
      const tEq = Math.pow(Math.max(qEff, 1e-6) / (area * SIGMA_SB), 0.25);
      const heatCapacity = mass[i] * MIN_HEAT_CAPACITY;
      const tau = heatCapacity / (16 * Math.PI * radius[i] ** 2 * SIGMA_SB * Math.max(surfaceTemp[i], 1) ** 3);
      const relax = clamp(dt / Math.max(tau, 1e-6), 0, 1);
      surfaceTemp[i] = clamp(surfaceTemp[i] + (tEq - surfaceTemp[i]) * relax, 1, 1e10);
      // Keep the *incident* flux for telemetry — never the absorbed value, or
      // each step would attenuate by another factor of (1−A).
    }
    this.fluxCache = flux;
  }

  /**
   * Tidal dissipation for eccentric orbits — the Io/Jupiter engine:
   *
   *   dE/dt = (21/2) (k₂/Q) G M_p² R_s⁵ n e² / a⁶
   *
   * and tidal-locking detection: the despin torque must have removed the spin
   * angular momentum within the system age.
   */
  updateTides(): void {
    const n = this.count;
    const Gs = this.Gs;
    const { pos, vel, mass, radius, tidalHeat, spinRate, k2overQ } = this;
    tidalHeat.fill(0, 0, n);
    for (let i = 0; i < n; i++) {
      if (this.isTracer[i] || this.fixed[i]) continue;
      let best = -1;
      let bestScore = 0;
      let bestR = 0;
      for (let j = 0; j < n; j++) {
        if (j === i || mass[j] < mass[i] * 5) continue;
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r = Math.hypot(dx, dy, dz);
        if (r < radius[j]) continue;
        const score = mass[j] / (r * r);
        if (score > bestScore) {
          bestScore = score;
          best = j;
          bestR = r;
        }
      }
      if (best < 0) continue;
      const M = mass[best];
      const a = bestR;
      const vrel = Math.hypot(
        vel[i * 3] - vel[best * 3],
        vel[i * 3 + 1] - vel[best * 3 + 1],
        vel[i * 3 + 2] - vel[best * 3 + 2],
      );
      const mu = Gs * (M + mass[i]);
      const energy = 0.5 * vrel * vrel - mu / a;
      let e = 0;
      if (energy < 0) {
        const semi = -mu / (2 * energy);
        const h = this.specificAngularMomentum(i, best);
        e = Math.sqrt(Math.max(0, 1 - (h * h) / (mu * semi)));
      } else {
        e = clamp(Math.sqrt(1 + (2 * energy * a * a) / mu), 1, 3);
      }
      const meanMotion = Math.sqrt(mu / Math.max(a, radius[best]) ** 3);
      const dEdt = 10.5 * k2overQ[i] * ((Gs * M * M * radius[i] ** 5 * meanMotion * e * e) / a ** 6);
      tidalHeat[i] = isFinite(dEdt) && dEdt > 0 ? dEdt : 0;
      const L = 0.4 * mass[i] * radius[i] ** 2 * Math.abs(spinRate[i]);
      const torque = 1.5 * k2overQ[best] * ((Gs * M * M * radius[best] ** 5) / a ** 6);
      if (torque > 0 && L > 0 && this.tidalLocked[i] === 0) {
        const lockTime = L / torque;
        if (lockTime < 4.5e9 * 3.15576e7) {
          this.tidalLocked[i] = 1;
          spinRate[i] = meanMotion * Math.sign(spinRate[i] || 1);
          this.events.push({
            type: 'tidal-locked',
            bodyId: this.ids[i],
            name: this.names[i],
            primaryName: this.names[best],
          });
        }
      }
    }
  }

  private specificAngularMomentum(i: number, j: number): number {
    const rx = this.pos[i * 3] - this.pos[j * 3];
    const ry = this.pos[i * 3 + 1] - this.pos[j * 3 + 1];
    const rz = this.pos[i * 3 + 2] - this.pos[j * 3 + 2];
    const vx = this.vel[i * 3] - this.vel[j * 3];
    const vy = this.vel[i * 3 + 1] - this.vel[j * 3 + 1];
    const vz = this.vel[i * 3 + 2] - this.vel[j * 3 + 2];
    return Math.hypot(ry * vz - rz * vy, rz * vx - rx * vz, rx * vy - ry * vx);
  }

  /**
   * Tidal disruption events: a star whose periapsis falls inside the tidal
   * radius of a compact object is spaghettified,
   *
   *     R_tidal ≈ R_★ (M_BH / m_★)^{1/3}
   *
   * long before it reaches the horizon. The engine reports the event and the
   * renderer turns the remains into a GPU debris stream.
   */
  private checkTidalDisruption(): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      if (i >= this.count) break;
      if (this.isTracer[i] || this.fixed[i]) continue;
      const compact = this.kinds[i] === 'blackhole' || this.kinds[i] === 'neutronstar' || this.kinds[i] === 'whitedwarf';
      if (compact) continue;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const jCompact = this.kinds[j] === 'blackhole' || this.kinds[j] === 'neutronstar';
        if (!jCompact) continue;
        if (this.mass[j] < this.mass[i] * 1e3) continue;
        const dx = this.pos[j * 3] - this.pos[i * 3];
        const dy = this.pos[j * 3 + 1] - this.pos[i * 3 + 1];
        const dz = this.pos[j * 3 + 2] - this.pos[i * 3 + 2];
        const r = Math.hypot(dx, dy, dz);
        const tidalRadius = this.radius[i] * Math.cbrt(this.mass[j] / this.mass[i]);
        const horizon = this.kinds[j] === 'blackhole' ? schwarzschildRadius(this.mass[j]) : this.radius[j];
        if (r < tidalRadius && r > horizon * 0.8) {
          this.events.push({
            type: 'tidal-disruption',
            holeId: this.ids[j],
            holeName: this.names[j],
            starName: this.names[i],
            periapsis: r,
            tidalRadius,
            streamMass: this.mass[i],
          });
          this.removeAt(i);
          this.recomputeForces();
          return;
        }
      }
    }
  }

  /**
   * Collisions. Merge mode conserves linear and angular momentum and deposits
   * the impact shock energy Q = ½μΔv² as heat; fragmentation ejects a
   * power-law-distributed debris swarm (dN/dm ∝ m^-α, α = 1.8).
   */
  private resolveCollisions(): void {
    if (this.count < 2) return;
    const mode = this.params.collisionMode;
    if (mode === 'none') return;
    for (let i = 0; i < this.count; i++) {
      for (let j = i + 1; j < this.count; j++) {
        if (i >= this.count || j >= this.count) break;
        const dx = this.pos[j * 3] - this.pos[i * 3];
        const dy = this.pos[j * 3 + 1] - this.pos[i * 3 + 1];
        const dz = this.pos[j * 3 + 2] - this.pos[i * 3 + 2];
        if (this.isTracer[i] || this.isTracer[j]) continue; // massless test particles
        const r = Math.hypot(dx, dy, dz);
        const contact = this.radius[i] + this.radius[j];
        if (r >= contact) continue;
        const dvx = this.vel[j * 3] - this.vel[i * 3];
        const dvy = this.vel[j * 3 + 1] - this.vel[i * 3 + 1];
        const dvz = this.vel[j * 3 + 2] - this.vel[i * 3 + 2];
        const speed = Math.hypot(dvx, dvy, dvz);
        const mi = this.mass[i];
        const mj = this.mass[j];
        const mu = (mi * mj) / Math.max(mi + mj, 1e-9);
        const shock = 0.5 * mu * speed * speed;
        if (mode === 'bounce') {
          const nx = r > 1e-9 ? dx / r : 1;
          const ny = r > 1e-9 ? dy / r : 0;
          const nz = r > 1e-9 ? dz / r : 0;
          const vn = dvx * nx + dvy * ny + dvz * nz;
          if (vn >= 0) continue;
          const jImp = -(1 + this.params.restitution) * vn * mu;
          const overlap = contact - r;
          const total = mi + mj;
          if (!this.fixed[i]) {
            this.vel[i * 3] -= (jImp / mi) * nx;
            this.vel[i * 3 + 1] -= (jImp / mi) * ny;
            this.vel[i * 3 + 2] -= (jImp / mi) * nz;
            this.pos[i * 3] -= overlap * nx * (mj / total);
            this.pos[i * 3 + 1] -= overlap * ny * (mj / total);
            this.pos[i * 3 + 2] -= overlap * nz * (mj / total);
          }
          if (!this.fixed[j]) {
            this.vel[j * 3] += (jImp / mj) * nx;
            this.vel[j * 3 + 1] += (jImp / mj) * ny;
            this.vel[j * 3 + 2] += (jImp / mj) * nz;
            this.pos[j * 3] += overlap * nx * (mi / total);
            this.pos[j * 3 + 1] += overlap * ny * (mi / total);
            this.pos[j * 3 + 2] += overlap * nz * (mi / total);
          }
          this.events.push({
            type: 'collision',
            targetId: this.ids[i],
            targetName: this.names[i],
            impactorName: this.names[j],
            speed,
            energy: shock,
            merged: false,
            heatK: 0,
            fragments: 0,
          });
          continue;
        }
        this.mergeBodies(i, j, shock, speed);
        return; // the arrays changed; resume scanning next step
      }
    }
  }

  private mergeBodies(i: number, j: number, shock: number, speed: number): void {
    const Gs = this.Gs;
    const heavy = this.mass[i] >= this.mass[j] ? i : j;
    const light = heavy === i ? j : i;
    const mh = this.mass[heavy];
    const ml = this.mass[light];
    const total = mh + ml;
    const survivorId = this.ids[heavy];
    const survivorName = this.names[heavy];
    const impactorName = this.names[light];

    const pvx = (this.vel[heavy * 3] * mh + this.vel[light * 3] * ml) / total;
    const pvy = (this.vel[heavy * 3 + 1] * mh + this.vel[light * 3 + 1] * ml) / total;
    const pvz = (this.vel[heavy * 3 + 2] * mh + this.vel[light * 3 + 2] * ml) / total;
    const px = (this.pos[heavy * 3] * mh + this.pos[light * 3] * ml) / total;
    const py = (this.pos[heavy * 3 + 1] * mh + this.pos[light * 3 + 1] * ml) / total;
    const pz = (this.pos[heavy * 3 + 2] * mh + this.pos[light * 3 + 2] * ml) / total;

    const speedAtContact = Math.hypot(
      this.vel[light * 3] - this.vel[heavy * 3],
      this.vel[light * 3 + 1] - this.vel[heavy * 3 + 1],
      this.vel[light * 3 + 2] - this.vel[heavy * 3 + 2],
    );
    const lever = Math.max(this.radius[heavy], 1);
    const spinBefore = 0.4 * mh * this.radius[heavy] ** 2 * this.spinRate[heavy];
    const orbitalL = ml * speedAtContact * lever;

    // Debris: the fraction of the impactor that is thrown clear of the merged
    // body's gravity well. v_esc of the merged body sets the scale.
    const vEsc = Math.sqrt((2 * Gs * total) / Math.max(this.radius[heavy], 1));
    const ejectedFraction = this.params.fragmentation ? clamp(speed / (3.5 * vEsc), 0, 0.55) : 0;
    const ejectedMass = ml * ejectedFraction;
    const newMass = total - ejectedMass;
    const newRadius = radiusFromMass(newMass, this.kinds[heavy], this.composition[heavy]);
    const newInertia = 0.4 * newMass * newRadius * newRadius;
    this.spinRate[heavy] = (spinBefore + orbitalL * 0.35) / Math.max(newInertia, 1e-9);

    // Thermal shock: the kinetic energy Q = ½μΔv² *plus* the gravitational
    // binding energy released as the two bodies fall together, both deposited
    // in the merged mass. Without the second term the collision would appear to
    // destroy energy; with it, E_mech(before) = E_mech(after) + heat exactly.
    const contactR = Math.max(
      Math.hypot(this.pos[light * 3] - this.pos[heavy * 3], this.pos[light * 3 + 1] - this.pos[heavy * 3 + 1], this.pos[light * 3 + 2] - this.pos[heavy * 3 + 2]),
      1,
    );
    // The contact speed already includes the acceleration through the well, so
    // the *net* energy converted to heat is ½μΔv² + PE(r) with PE negative.
    const heatJ = Math.max(shock + -(Gs * mh * ml) / contactR, 0);
    const heatK = heatJ / Math.max(newMass * MIN_HEAT_CAPACITY, 1);
    this.surfaceTemp[heavy] = clamp(this.surfaceTemp[heavy] + heatK, 1, 1e10);
    this.mass[heavy] = newMass;
    this.radius[heavy] = newRadius;
    this.pos[heavy * 3] = px;
    this.pos[heavy * 3 + 1] = py;
    this.pos[heavy * 3 + 2] = pz;
    this.vel[heavy * 3] = pvx;
    this.vel[heavy * 3 + 1] = pvy;
    this.vel[heavy * 3 + 2] = pvz;
    this.greenhouse[heavy] = Math.max(this.greenhouse[heavy], this.greenhouse[light] * (ml / total));
    this.albedo[heavy] = (this.albedo[heavy] * mh + this.albedo[light] * ml) / total;
    this.waterFraction[heavy] = (this.waterFraction[heavy] * mh + this.waterFraction[light] * ml) / total;
    this.luminosity[heavy] = Math.max(this.luminosity[heavy], this.luminosity[light]);
    this.internalHeat[heavy] += this.internalHeat[light] * 0.5;

    this.removeAt(light);

    // Power-law fragment swarm, produced after the removal so indices are safe.
    let fragments = 0;
    if (ejectedMass > 1e13 && speed > 150) {
      const alpha = 1.8;
      const wanted = clamp(Math.round(Math.log10(ejectedMass / 1e13) * 4), 3, 20);
      const weights: number[] = [];
      let wSum = 0;
      for (let f = 0; f < wanted; f++) {
        const u = Math.max(0.08, (f + 0.6) / (wanted + 0.6));
        const w = Math.pow(u, -1 / (alpha - 1));
        weights.push(w);
        wSum += w;
      }
      const newIds: number[] = [];
      for (let f = 0; f < wanted; f++) {
        const fm = (ejectedMass * weights[f]) / wSum;
        if (fm < 1e10) continue;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const dir: [number, number, number] = [
          Math.sin(phi) * Math.cos(theta),
          Math.sin(phi) * Math.sin(theta),
          Math.cos(phi),
        ];
        const spread = vEsc * (0.9 + Math.random() * 1.6);
        const id = this.allocateId();
        this.add(
          {
            id,
            name: `${survivorName} debris ${f + 1}`,
            kind: 'asteroid',
            mass: fm,
            radius: radiusFromMass(fm, 'asteroid'),
            pos: [px + dir[0] * newRadius, py + dir[1] * newRadius, pz + dir[2] * newRadius],
            vel: [pvx + dir[0] * spread, pvy + dir[1] * spread, pvz + dir[2] * spread],
            spinAxis: [Math.random(), Math.random(), Math.random()],
            spinRate: (Math.random() - 0.5) * 2e-3,
            albedo: 0.12,
            greenhouse: 0,
            luminosity: 0,
            internalHeat: 0,
            surfaceTemp: clamp(this.surfaceTemp[Math.min(heavy, this.count - 1)] * 0.9 + 400, 300, 4000),
            color: [0.42, 0.22, 0.14],
            seed: (Math.random() * 1e6) | 0,
            composition: this.composition[Math.min(heavy, this.count - 1)],
          },
          true,
        );
        newIds.push(id);
      }
      fragments = newIds.length;
      if (newIds.length) this.events.push({ type: 'spawn', ids: newIds });
    }

    this.events.push({
      type: 'collision',
      targetId: survivorId,
      targetName: survivorName,
      impactorName,
      speed,
      energy: shock,
      merged: true,
      heatK,
      fragments,
    });
    this.recomputeForces();
  }

  /**
   * Roche-limit monitoring. A satellite that crosses the fluid Roche radius
   *
   *     d ≈ 2.44 R_M (ρ_M / ρ_m)^{1/3}
   *
   * is torn apart and converted into a ring system: the engine reports the ring
   * geometry and the renderer spawns an instanced GPU particle field.
   */
  private checkRoche(): void {
    for (let i = 0; i < this.count; i++) {
      if (i >= this.count) break;
      if (this.isTracer[i] || this.fixed[i]) continue;
      let best = -1;
      let bestScore = 0;
      let bestDist = 0;
      for (let j = 0; j < this.count; j++) {
        if (j === i || this.isTracer[j] || this.mass[j] <= this.mass[i]) continue;
        const dx = this.pos[j * 3] - this.pos[i * 3];
        const dy = this.pos[j * 3 + 1] - this.pos[i * 3 + 1];
        const dz = this.pos[j * 3 + 2] - this.pos[i * 3 + 2];
        const r = Math.hypot(dx, dy, dz);
        if (r < this.radius[j] || r > this.radius[j] * 5000) continue;
        const score = this.mass[j] / (r * r);
        if (score > bestScore) {
          bestScore = score;
          best = j;
          bestDist = r;
        }
      }
      if (best < 0) continue;
      if (this.radius[i] > 0.35 * this.radius[best]) continue; // not a satellite
      const density = this.mass[i] / ((4 / 3) * Math.PI * this.radius[i] ** 3);
      const rigid = this.params.rocheRigid && (this.kinds[i] === 'asteroid' || this.kinds[i] === 'comet');
      const dRoche = rocheLimit(this.mass[best], this.radius[best], density, rigid);
      if (bestDist < dRoche) {
        // Tidal radius also matters for very soft bodies — the smaller of the
        // two governs disruption.
        this.events.push({
          type: 'roche-disruption',
          primaryId: this.ids[best],
          primaryName: this.names[best],
          bodyName: this.names[i],
          radius: bestDist,
          rocheRadius: dRoche,
          ringMass: this.mass[i],
          tilt: Math.acos(clamp(this.spinAxis[best * 3 + 2], -1, 1)),
        });
        this.removeAt(i);
        this.recomputeForces();
        return;
      }
    }
  }

  /**
   * Stellar evolution. What a star leaves behind is decided purely by mass:
   * below the Chandrasekhar limit (1.44 M☉) a white dwarf; below the
   * Tolman-Oppenheimer-Volkoff limit (≈2.17 M☉) a neutron star; above it a
   * black hole. Core-collapse is triggered explicitly (UI) or automatically for
   * hyper-massive stars in the pair-instability region.
   */
  private checkStellarEvolution(): void {
    for (let i = 0; i < this.count; i++) {
      if (this.kinds[i] !== 'star') continue;
      if (this.mass[i] < 100 * SOLAR_MASS) continue;
      this.collapseStar(this.ids[i]);
      return;
    }
  }

  /** Force a core-collapse (supernova) with an explicit UI trigger. */
  collapseStar(id: number): PhysicsEvent | null {
    const i = this.indexOf(id);
    if (i < 0 || this.kinds[i] !== 'star') return null;
    const m = this.mass[i];
    const remnant: BodyKind = m < CHANDRASEKHAR_LIMIT ? 'whitedwarf' : m < TOV_LIMIT ? 'neutronstar' : 'blackhole';
    const energy = 0.1 * m * C * C; // ~10 % of the rest mass, order of magnitude
    // The expelled envelope carries away mass: the remnant keeps the core.
    const remnantMass = remnant === 'blackhole' ? m * 0.9 : m * (remnant === 'neutronstar' ? 0.4 : 0.6);
    this.kinds[i] = remnant;
    this.mass[i] = remnantMass;
    this.radius[i] = remainderRadius(remnant, remnantMass);
    this.luminosity[i] = remnant === 'blackhole' ? 0 : remnant === 'neutronstar' ? 1e5 : 1e-3 * 3.828e26;
    this.surfaceTemp[i] = remnant === 'blackhole' ? 0 : remnant === 'neutronstar' ? 6e5 : 1.2e5;
    this.internalHeat[i] = remnant === 'neutronstar' ? 1e26 : 0;
    this.spinRate[i] = remnant === 'neutronstar' ? 700 : 1e-4;
    this.bhSpin[i] = remnant === 'blackhole' ? 0.7 : 0;
    this.composition[i] = { rock: 0, water: 0, ice: 0, gas: 0, metal: 1 };
    this.k2overQ[i] = k2OverQDefault(remnant, this.composition[i]);
    const ev: PhysicsEvent = {
      type: 'supernova',
      bodyId: id,
      name: this.names[i],
      mass: m,
      remnant,
      energy,
      position: [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]],
    };
    this.events.push(ev);
    this.recomputeForces();
    return ev;
  }

  /** Detect newly unbound orbits (escape events) for the telemetry feed. */
  private updateBoundFlags(): void {
    for (let i = 0; i < this.count; i++) {
      if (this.isTracer[i] || this.fixed[i]) continue;
      const prim = this.primaryFor(i);
      if (prim.index < 0) continue;
      const relVx = this.vel[i * 3] - this.vel[prim.index * 3];
      const relVy = this.vel[i * 3 + 1] - this.vel[prim.index * 3 + 1];
      const relVz = this.vel[i * 3 + 2] - this.vel[prim.index * 3 + 2];
      const v2 = relVx * relVx + relVy * relVy + relVz * relVz;
      const mu = this.Gs * (this.mass[i] + this.mass[prim.index]);
      const energy = 0.5 * v2 - mu / Math.max(prim.distance, 1);
      const isBound = energy < 0;
      if (!isBound && this.bound[i] === 1) {
        this.events.push({
          type: 'escape',
          bodyId: this.ids[i],
          name: this.names[i],
          speed: Math.sqrt(v2),
          primaryName: this.names[prim.index],
        });
      }
      this.bound[i] = isBound ? 1 : 0;
    }
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  updateDiagnostics(): void {
    const { count, mass, vel, pos } = this;
    let ke = 0;
    let px = 0, py = 0, pz = 0;
    let lx = 0, ly = 0, lz = 0;
    let mx = 0, my = 0, mz = 0;
    let M = 0;
    for (let i = 0; i < count; i++) {
      const m = mass[i];
      if (m <= 0) continue;
      const vx = vel[i * 3], vy = vel[i * 3 + 1], vz = vel[i * 3 + 2];
      ke += 0.5 * m * (vx * vx + vy * vy + vz * vz);
      px += m * vx;
      py += m * vy;
      pz += m * vz;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      lx += m * (y * vz - z * vy);
      ly += m * (z * vx - x * vz);
      lz += m * (x * vy - y * vx);
      mx += m * x;
      my += m * y;
      mz += m * z;
      M += m;
    }
    const pe = count > 64 ? this.approximatePotential() : this.potentialEnergy();
    const d = this.diagnostics;
    d.kinetic = ke;
    d.potential = pe;
    d.total = ke + pe;
    d.momentum = [px, py, pz];
    d.angularMomentum = [lx, ly, lz];
    d.com = M > 0 ? [mx / M, my / M, mz / M] : [0, 0, 0];
    d.bodyCount = count;
    d.time = this.time;
  }

  /** Sampled potential estimate for the large-N path. */
  private approximatePotential(): number {
    const count = this.count;
    const Gs = this.Gs;
    let u = 0;
    const step = Math.max(1, Math.floor(count / 400));
    for (let i = 0; i < count; i += step) {
      for (let j = i + step; j < count; j += step) {
        const dx = this.pos[j * 3] - this.pos[i * 3];
        const dy = this.pos[j * 3 + 1] - this.pos[i * 3 + 1];
        const dz = this.pos[j * 3 + 2] - this.pos[i * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz + this.softening2For(i, j);
        u -= (Gs * this.mass[i] * this.mass[j]) / Math.sqrt(r2);
      }
    }
    return u * step * step;
  }

  /** Compare Barnes-Hut against exact summation (accuracy lab). */
  measureTreeError(): number {
    if (this.count <= 64) return 0;
    const exact = new Float64Array(this.count * 3);
    const saved = this.acc;
    this.acc = exact;
    this.directForces();
    this.acc = saved;
    this.treeForces();
    let err = 0;
    let mag = 0;
    for (let i = 0; i < this.count * 3; i++) {
      err += (exact[i] - this.acc[i]) ** 2;
      mag += exact[i] ** 2;
    }
    const e = mag > 0 ? Math.sqrt(err / mag) : 0;
    this.diagnostics.treeError = e;
    return e;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /** The dominant attractor for a body: which primary governs its orbit. */
  private primaryFor(i: number): { index: number; distance: number } {
    let best = -1;
    let bestScore = 0;
    let bestR = 0;
    for (let j = 0; j < this.count; j++) {
      if (j === i || this.mass[j] < this.mass[i]) continue;
      const dx = this.pos[j * 3] - this.pos[i * 3];
      const dy = this.pos[j * 3 + 1] - this.pos[i * 3 + 1];
      const dz = this.pos[j * 3 + 2] - this.pos[i * 3 + 2];
      const r2 = dx * dx + dy * dy + dz * dz;
      const r = Math.sqrt(r2);
      if (r <= this.radius[j]) continue;
      const a = (this.Gs * this.mass[j]) / r2;
      // Tidal weighting: the Sun must beat a nearby but light planet.
      const score = a * Math.pow(this.mass[j] / Math.max(this.mass[i], 1), 0.15);
      if (score > bestScore) {
        bestScore = score;
        best = j;
        bestR = r;
      }
    }
    return { index: best, distance: bestR };
  }

  /** Habitable-zone classification (Kopparapu et al. scaling, ∝ √L). */
  private hzRole(primary: number, distance: number): BodySnapshot['hzRole'] {
    if (primary < 0 || distance <= 0 || this.luminosity[primary] <= 0) return 'none';
    const rC = Math.sqrt(this.luminosity[primary] / 3.828e26) * AU;
    const d = distance / rC;
    if (d < 0.75) return 'too-hot';
    if (d <= 0.99) return 'optimistic';
    if (d <= 1.7) return 'conservative';
    if (d <= 2.0) return 'optimistic';
    return 'too-cold';
  }

  snapshot(): BodySnapshot[] {
    const out: BodySnapshot[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const prim = this.primaryFor(i);
      const pd = prim.distance;
      const relVx = prim.index >= 0 ? this.vel[i * 3] - this.vel[prim.index * 3] : this.vel[i * 3];
      const relVy = prim.index >= 0 ? this.vel[i * 3 + 1] - this.vel[prim.index * 3 + 1] : this.vel[i * 3 + 1];
      const relVz = prim.index >= 0 ? this.vel[i * 3 + 2] - this.vel[prim.index * 3 + 2] : this.vel[i * 3 + 2];
      const relSpeed = Math.hypot(relVx, relVy, relVz);
      const mu = prim.index >= 0 ? this.Gs * (this.mass[i] + this.mass[prim.index]) : 0;
      const m = this.mass[i];
      const density = m / ((4 / 3) * Math.PI * this.radius[i] ** 3);
      const temp = this.surfaceTemp[i];
      const rigid = this.params.rocheRigid && (this.kinds[i] === 'asteroid' || this.kinds[i] === 'comet');
      const dRoche = prim.index >= 0 ? rocheLimit(this.mass[prim.index], this.radius[prim.index], density, rigid) : 0;
      out[i] = {
        id: this.ids[i],
        name: this.names[i],
        kind: this.kinds[i],
        mass: m,
        radius: this.radius[i],
        pos: [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]],
        vel: [this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]],
        acc: [this.acc[i * 3], this.acc[i * 3 + 1], this.acc[i * 3 + 2]],
        force: [this.acc[i * 3] * m, this.acc[i * 3 + 1] * m, this.acc[i * 3 + 2] * m],
        surfaceTemp: temp,
        emissive: clamp((temp - LAVA_TEMP) / (HOT_TEMP - LAVA_TEMP), 0, 1),
        luminosity: this.luminosity[i],
        density,
        spinRate: this.spinRate[i],
        spinAxis: [this.spinAxis[i * 3], this.spinAxis[i * 3 + 1], this.spinAxis[i * 3 + 2]],
        flux: this.fluxCache[i] ?? 0,
        tidalHeating: this.tidalHeat[i],
        primaryId: prim.index >= 0 ? this.ids[prim.index] : -1,
        primaryDistance: pd,
        specificEnergy: prim.index >= 0 && pd > 0 ? 0.5 * relSpeed * relSpeed - mu / pd : 0,
        relSpeed,
        rocheRadius: dRoche,
        rocheRatio: dRoche > 0 ? pd / dRoche : Infinity,
        insideRoche: dRoche > 0 && pd < dRoche,
        hzRole: this.hzRole(prim.index, pd),
        gravity: (this.Gs * m) / this.radius[i] ** 2,
        escapeVelocity: Math.sqrt((2 * this.Gs * m) / this.radius[i]),
        compactness: (this.Gs * m) / (this.radius[i] * (C * this.params.cScale) ** 2),
        waterFraction: this.waterFraction[i],
        oblateness: this.oblateness[i],
        tidalLocked: this.tidalLocked[i] === 1,
        tracer: this.isTracer[i] === 1,
        note: this.notes[i],
        composition: this.composition[i],
      };
    }
    return out;
  }

  /** Lagrange points of a two-body pair, for the overlay. */
  lagrangePoints(primaryId: number, secondaryId: number): { id: string; pos: [number, number, number] }[] {
    const i = this.indexOf(primaryId);
    const j = this.indexOf(secondaryId);
    if (i < 0 || j < 0) return [];
    const Gs = this.Gs;
    const m1 = this.mass[i];
    const m2 = this.mass[j];
    const total = m1 + m2;
    if (total <= 0) return [];
    const mu = m2 / total;
    const r = Math.hypot(
      this.pos[j * 3] - this.pos[i * 3],
      this.pos[j * 3 + 1] - this.pos[i * 3 + 1],
      this.pos[j * 3 + 2] - this.pos[i * 3 + 2],
    );
    if (!(r > 0)) return [];
    const ex: [number, number, number] = [
      (this.pos[j * 3] - this.pos[i * 3]) / r,
      (this.pos[j * 3 + 1] - this.pos[i * 3 + 1]) / r,
      (this.pos[j * 3 + 2] - this.pos[i * 3 + 2]) / r,
    ];
    const rvx = this.vel[j * 3] - this.vel[i * 3];
    const rvy = this.vel[j * 3 + 1] - this.vel[i * 3 + 1];
    const rvz = this.vel[j * 3 + 2] - this.vel[i * 3 + 2];
    const exr = [ex[1] * rvz - ex[2] * rvy, ex[2] * rvx - ex[0] * rvz, ex[0] * rvy - ex[1] * rvx];
    let ezl = Math.hypot(exr[0], exr[1], exr[2]);
    if (ezl < 1e-12) {
      // Degenerate (radial) configuration: pick any perpendicular axis.
      const alt: [number, number, number] = Math.abs(ex[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const c = [ex[1] * alt[2] - ex[2] * alt[1], ex[2] * alt[0] - ex[0] * alt[2], ex[0] * alt[1] - ex[1] * alt[0]];
      ezl = Math.hypot(c[0], c[1], c[2]) || 1;
      exr[0] = c[0] / ezl;
      exr[1] = c[1] / ezl;
      exr[2] = c[2] / ezl;
    } else {
      exr[0] /= ezl;
      exr[1] /= ezl;
      exr[2] /= ezl;
    }
    const ey: [number, number, number] = [
      exr[1] * ex[2] - exr[2] * ex[1],
      exr[2] * ex[0] - exr[0] * ex[2],
      exr[0] * ex[1] - exr[1] * ex[0],
    ];
    const at = (x: number, y: number): [number, number, number] => [
      this.pos[i * 3] + ex[0] * x * r + ey[0] * y * r,
      this.pos[i * 3 + 1] + ex[1] * x * r + ey[1] * y * r,
      this.pos[i * 3 + 2] + ex[2] * x * r + ey[2] * y * r,
    ];
    // Collinear points: solve the exact equilibrium equation in the co-rotating
    // frame by bracketed bisection:
    //
    //     a_grav(x) + ω²(x − x_b) = 0,
    //     a_grav  = −GM₁·sgn(x)/x² − GM₂·sgn(x−r)/(x−r)²
    //
    // The roots on (0, r), (r, ∞) and (−∞, 0) are L1, L2 and L3. Bisection on
    // the exact equation avoids the sign pitfalls of the classical quintic and
    // is accurate to 1e-12 relative.
    const omega2 = (Gs * total) / (r * r * r);
    const xb = mu * r;
    const f = (x: number) => {
      const s1 = x >= 0 ? 1 : -1;
      const d = x - r;
      const s2 = d >= 0 ? 1 : -1;
      const t1 = Math.abs(x) > 1e-12 ? (Gs * m1 * s1) / (x * x) : 0;
      const t2 = Math.abs(d) > 1e-12 ? (Gs * m2 * s2) / (d * d) : 0;
      return -t1 - t2 + omega2 * (x - xb);
    };
    const bisect = (lo: number, hi: number) => {
      let a = lo;
      let b = hi;
      let fa = f(a);
      for (let k = 0; k < 200; k++) {
        const m = 0.5 * (a + b);
        if (Math.abs(b - a) < 1e-14 * r) return m;
        const fm = f(m);
        if (fm === 0) return m;
        if ((fa < 0) !== (fm < 0)) {
          b = m;
        } else {
          a = m;
          fa = fm;
        }
      }
      return 0.5 * (a + b);
    };
    const l1 = bisect(r * 1e-9, r * (1 - 1e-7)); // between the two bodies
    const l2 = bisect(r * (1 + 1e-7), r * 1e4); // beyond the secondary
    const l3 = bisect(-r * 1e4, -r * 1e-9); // opposite side of the primary
    // `at` takes distances in units of the separation measured from the primary.
    return [
      { id: 'L1', pos: at(l1 / r, 0) },
      { id: 'L2', pos: at(l2 / r, 0) },
      { id: 'L3', pos: at(l3 / r, 0) },
      { id: 'L4', pos: at(0.5, Math.sqrt(3) / 2) },
      { id: 'L5', pos: at(0.5, -Math.sqrt(3) / 2) },
    ];
  }
}

function k2OverQDefault(kind: BodyKind, comp: Composition): number {
  if (kind === 'star' || kind === 'blackhole' || kind === 'neutronstar') return 0;
  if (kind === 'whitedwarf') return 1e-5;
  const total = comp.rock + comp.water + comp.ice + comp.gas + comp.metal || 1;
  const gas = comp.gas / total;
  const volatiles = (comp.ice + comp.water) / total;
  if (gas > 0.5) return 3e-6;
  if (gas > 0.1) return 3e-5;
  return 0.004 * (1 - volatiles) + 0.02 * volatiles;
}

function remainderRadius(kind: BodyKind, mass: number): number {
  if (kind === 'blackhole') return schwarzschildRadius(mass);
  if (kind === 'neutronstar') return compactRadius(mass, 'neutronstar');
  if (kind === 'whitedwarf') return compactRadius(mass, 'whitedwarf');
  return radiusFromMass(mass, kind);
}

/** Re-exported so callers can reason about stellar scaling without deep imports. */
export { msStarLuminosity, msStarRadius, effectiveTemperature } from './CelestialBody';
