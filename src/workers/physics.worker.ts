/// <reference lib="webworker" />
/**
 * Physics worker.
 *
 * Owns the single `PhysicsEngine` instance and runs the fixed-timestep loop
 * completely decoupled from rendering.  The main thread only ever asks for
 * "advance by dt seconds" and receives compact transferable snapshots, so a
 * slow frame in the renderer can never destabilise a planetary orbit.
 *
 * Snapshots use a three-buffer pool: the worker transfers arrays out, the main
 * thread uploads them to the GPU and transfers them straight back.  Zero
 * allocation in the steady state.
 */

import { PhysicsEngine, DEFAULT_PARAMS, type PhysicsParams } from '../physics/PhysicsEngine';
import { orbitalElements } from '../physics/OrbitalElements';
import { eddingtonLuminosity } from '../core/units';
import { findPreset } from '../sim/presets';
import {
  BodyFlags,
  type BodyTelemetry,
  type MainToWorker,
  type RingParticleChunk,
  type ScenarioName,
  type Snapshot,
  type WorkerToMain,
} from '../sim/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let engine = new PhysicsEngine(4096);
let selectedId = -1;
let focusId = -1;
let lagrangePair: [number, number] | null = null;
let seq = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Ring / debris particle field (the instanced GPU side of Roche disruption)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RING_PARTICLES = 26000;

interface ParticleField {
  count: number;
  host: Int32Array;
  radius: Float64Array;
  theta: Float64Array;
  omega: Float64Array;
  size: Float64Array;
  height: Float64Array;
  tempOffset: Float64Array;
  /** Payload handed to the renderer. */
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  sizes: Float32Array;
  temps: Float32Array;
  hostIds: Int32Array;
}

const field: ParticleField = {
  count: 0,
  host: new Int32Array(MAX_RING_PARTICLES),
  radius: new Float64Array(MAX_RING_PARTICLES),
  theta: new Float64Array(MAX_RING_PARTICLES),
  omega: new Float64Array(MAX_RING_PARTICLES),
  size: new Float64Array(MAX_RING_PARTICLES),
  height: new Float64Array(MAX_RING_PARTICLES),
  tempOffset: new Float64Array(MAX_RING_PARTICLES),
  px: new Float32Array(MAX_RING_PARTICLES * 3),
  py: new Float32Array(MAX_RING_PARTICLES),
  pz: new Float32Array(MAX_RING_PARTICLES),
  sizes: new Float32Array(MAX_RING_PARTICLES),
  temps: new Float32Array(MAX_RING_PARTICLES),
  hostIds: new Int32Array(MAX_RING_PARTICLES),
};

/**
 * Rebuild the ring field from the engine's per-body ring description. Each
 * particle is given a Keplerian angular velocity n = √(GM_host / r³), so the
 * ring shears exactly as a real one does (inner particles lap the outer ones).
 */
function rebuildParticles(): void {
  let w = 0;
  for (let i = 0; i < engine.count && w < MAX_RING_PARTICLES; i++) {
    const n = engine.ringParticles[i];
    if (!n) continue;
    const inner = Math.max(engine.ringInner[i] || engine.radius[i] * 1.5, engine.radius[i] * 1.02);
    const outer = Math.max(engine.ringOuter[i] || inner * 1.6, inner * 1.05);
    const mu = engine.G * engine.mass[i];
    let seed = engine.seeds[i] || 1;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const band = outer - inner;
    for (let k = 0; k < n && w < MAX_RING_PARTICLES; k++) {
      const u = rnd();
      const r = inner + band * Math.sqrt(u);
      field.host[w] = i;
      field.radius[w] = r;
      field.theta[w] = rnd() * Math.PI * 2;
      field.omega[w] = Math.sqrt(mu / (r * r * r));
      field.size[w] = Math.max(band / 240, engine.radius[i] * 2e-3);
      field.height[w] = (rnd() - 0.5) * band * 0.035;
      field.tempOffset[w] = rnd();
      w++;
    }
  }
  field.count = w;
}

/** Advance ring particle phases and write the transferable payload. */
function updateParticles(dt: number): void {
  const drag = 1 + Math.max(engine.params.drag, 0) * dt;
  for (let k = 0; k < field.count; k++) {
    field.theta[k] += field.omega[k] * dt;
    if (drag > 1) field.omega[k] /= drag; // ram-pressure drag spirals the ring in
    const r = field.radius[k];
    field.px[k * 3] = Math.cos(field.theta[k]) * r;
    field.px[k * 3 + 1] = field.height[k];
    field.px[k * 3 + 2] = Math.sin(field.theta[k]) * r;
    const h = field.host[k];
    field.sizes[k] = field.size[k];
    field.temps[k] = engine.surfaceTemp[h] + field.tempOffset[k] * 40;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot buffer pool
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotBuffers {
  pos: Float32Array;
  vel: Float32Array;
  radii: Float32Array;
  temp: Float32Array;
  flags: Uint8Array;
  tint: Float32Array;
  atmos: Float32Array;
  ids: Int32Array;
  accretion: Float32Array;
  particles: RingParticleChunk | null;
}
const pool: SnapshotBuffers[] = [];

function acquire(count: number, particleN: number): SnapshotBuffers {
  for (let i = 0; i < pool.length; i++) {
    const b = pool[i];
    const bodyOk = count <= b.pos.length / 3;
    const partOk = particleN === 0 ? b.particles === null : b.particles !== null && particleN <= b.particles.positions.length / 3;
    if (bodyOk && partOk) return pool.splice(i, 1)[0];
  }
  return {
    pos: new Float32Array(count * 3),
    vel: new Float32Array(count * 3),
    radii: new Float32Array(count),
    temp: new Float32Array(count),
    flags: new Uint8Array(count),
    tint: new Float32Array(count * 3),
    atmos: new Float32Array(count * 3),
    ids: new Int32Array(count),
    accretion: new Float32Array(count),
    particles:
      particleN > 0
        ? {
            positions: new Float32Array(particleN * 3),
            sizes: new Float32Array(particleN),
            temps: new Float32Array(particleN),
            count: particleN,
            hostIds: new Int32Array(particleN),
          }
        : null,
  };
}

function recycle(b: SnapshotBuffers): void {
  if (pool.length < 3) pool.push(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene construction
// ─────────────────────────────────────────────────────────────────────────────

function loadPreset(id: string, params?: Partial<PhysicsParams>): void {
  const preset = findPreset(id);
  if (!preset) throw new Error(`Unknown preset "${id}"`);
  currentPreset = id;
  selectedId = -1;
  focusId = -1;
  lagrangePair = null;
  engine = new PhysicsEngine(4096);
  engine.params = { ...DEFAULT_PARAMS, ...preset.params, ...params };
  engine.load(preset.build());
  rebuildParticles();
  ctx.postMessage({
    type: 'ready',
    presetId: preset.id,
    name: preset.name,
    lesson: preset.lesson,
    watchFor: preset.watchFor,
    camera: { focus: preset.camera.focus, distance: preset.camera.distance, elevation: preset.camera.elevation ?? 0 },
    timeWarp: preset.timeWarp ?? 1,
    overlays: preset.overlays ?? [],
    count: engine.count,
  } satisfies WorkerToMain);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshotting
// ─────────────────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<string, [number, number, number]> = {
  star: [1.0, 0.83, 0.55],
  planet: [0.55, 0.62, 0.78],
  moon: [0.72, 0.72, 0.72],
  asteroid: [0.5, 0.46, 0.42],
  comet: [0.62, 0.72, 0.8],
  blackhole: [0.05, 0.05, 0.06],
  neutronstar: [0.75, 0.85, 1.0],
  whitedwarf: [0.95, 0.97, 1.0],
  gascloud: [0.4, 0.35, 0.5],
  tracer: [0.4, 0.45, 0.55],
  galaxy: [0.6, 0.55, 0.5],
};

function describeComposition(c: { rock: number; water: number; ice: number; gas: number; metal: number }): string {
  const parts: string[] = [];
  const push = (label: string, v: number) => {
    if (v > 0.02) parts.push(`${label} ${(v * 100).toFixed(0)}%`);
  };
  push('rock', c.rock);
  push('ice', c.ice);
  push('water', c.water);
  push('gas', c.gas);
  push('metal', c.metal);
  return parts.join(' · ') || '—';
}

function buildTelemetry(): BodyTelemetry | null {
  const wanted = selectedId >= 0 ? selectedId : focusId;
  const i = wanted >= 0 ? engine.indexOfId(wanted) : -1;
  if (i < 0) return null;
  const prim = engine.primaryOfIndex(i);
  let elements: BodyTelemetry['elements'] = null;
  if (prim.index >= 0 && prim.index !== i) {
    const j = prim.index;
    const r: [number, number, number] = [
      engine.pos[i * 3] - engine.pos[j * 3],
      engine.pos[i * 3 + 1] - engine.pos[j * 3 + 1],
      engine.pos[i * 3 + 2] - engine.pos[j * 3 + 2],
    ];
    const v: [number, number, number] = [
      engine.vel[i * 3] - engine.vel[j * 3],
      engine.vel[i * 3 + 1] - engine.vel[j * 3 + 1],
      engine.vel[i * 3 + 2] - engine.vel[j * 3 + 2],
    ];
    const el = orbitalElements(r, v, engine.G * engine.mass[j]);
    elements = {
      a: el.a,
      e: el.e,
      i: el.i,
      argPeriapsis: el.argPeriapsis,
      ascendingNode: el.ascendingNode,
      trueAnomaly: el.trueAnomaly,
      period: el.period,
      apoapsis: el.apoapsis,
      periapsis: el.periapsis,
      speed: el.speed,
      escapeSpeed: el.escapeSpeed,
      circularSpeed: el.circularSpeed,
      meanMotion: el.meanMotion,
      bound: el.bound,
      hillRadius: engine.hillRadiusOf(i),
      rocheFluid: engine.rocheOf(i, false),
      rocheRigid: engine.rocheOf(i, true),
      specificEnergy: el.specificEnergy,
      angularMomentum: el.angularMomentum,
    };
  }
  const at = engine.atmospheres[i];
  const accretion = engine.accretionLuminosity[i];
  return {
    id: engine.ids[i],
    name: engine.names[i],
    primaryName: prim.index === i || prim.index < 0 ? '' : engine.names[prim.index],
    accretion,
    eddingtonFraction: engine.mass[i] > 0 ? accretion / eddingtonLuminosity(engine.mass[i]) : 0,
    accretionFuel: engine.accretionReservoir[i],
    kind: engine.kinds[i],
    mass: engine.mass[i],
    radius: engine.radius[i],
    luminosity: engine.luminosity[i],
    surfaceTemp: engine.surfaceTemp[i],
    equilibriumTemp: engine.equilibriumOf(i),
    greenhouse: engine.greenhouse[i],
    albedo: engine.albedo[i],
    tidalHeating: engine.tidalHeat[i],
    axialTilt: Math.acos(Math.min(1, Math.max(-1, engine.spinAxis[i * 3 + 2]))) * (180 / Math.PI),
    spinPeriod: engine.spinRate[i] !== 0 ? (2 * Math.PI) / Math.abs(engine.spinRate[i]) : 0,
    composition: describeComposition(engine.composition[i]),
    atmosphere: at ? { scaleHeight: at.scaleHeight, betaR: at.rayleigh[0], betaM: at.mie, top: engine.radius[i] + 6 * at.scaleHeight } : null,
    ring: engine.rings[i]
      ? { innerRadius: engine.rings[i]!.innerRadius, outerRadius: engine.rings[i]!.outerRadius, opacity: engine.rings[i]!.opacity }
      : null,
    elements,
    pos: [engine.pos[i * 3], engine.pos[i * 3 + 1], engine.pos[i * 3 + 2]],
    vel: [engine.vel[i * 3], engine.vel[i * 3 + 1], engine.vel[i * 3 + 2]],
    acc: [engine.acc[i * 3], engine.acc[i * 3 + 1], engine.acc[i * 3 + 2]],
    force: [engine.acc[i * 3] * engine.mass[i], engine.acc[i * 3 + 1] * engine.mass[i], engine.acc[i * 3 + 2] * engine.mass[i]],
    distanceToPrimary: prim.distance,
  };
}

/** Whether a compact object is present, so the grid mesh should curve. */
function detectDeformation(): boolean {
  for (let i = 0; i < engine.count; i++) {
    const k = engine.kinds[i];
    if (k === 'blackhole' || k === 'neutronstar') return true;
    const rs = engine.schwarzschildOf(i);
    if (rs > 0 && engine.radius[i] < 4 * rs) return true;
  }
  return false;
}

/**
 * L1–L5 for the current pair, converted from primary-relative to world
 * coordinates so the renderer can drop markers straight onto them.
 */
function computeLagrange(): { id: string; pos: [number, number, number] }[] | null {
  if (!lagrangePair) return null;
  const primaryIndex = engine.indexOfId(lagrangePair[0]);
  const secondaryIndex = engine.indexOfId(lagrangePair[1]);
  if (primaryIndex < 0 || secondaryIndex < 0) return null;
  const ox = engine.pos[primaryIndex * 3];
  const oy = engine.pos[primaryIndex * 3 + 1];
  const oz = engine.pos[primaryIndex * 3 + 2];
  return engine.lagrangePoints(lagrangePair[0], lagrangePair[1]).map((point) => ({
    id: point.id,
    pos: [point.pos[0] + ox, point.pos[1] + oy, point.pos[2] + oz] as [number, number, number],
  }));
}

function snapshot(): void {
  const n = engine.count;
  const b = acquire(n, field.count);
  const { pos, vel, radii, temp, flags, tint, atmos, ids, accretion } = b;
  for (let i = 0; i < n; i++) {
    pos[i * 3] = engine.pos[i * 3];
    pos[i * 3 + 1] = engine.pos[i * 3 + 1];
    pos[i * 3 + 2] = engine.pos[i * 3 + 2];
    vel[i * 3] = engine.vel[i * 3];
    vel[i * 3 + 1] = engine.vel[i * 3 + 1];
    vel[i * 3 + 2] = engine.vel[i * 3 + 2];
    radii[i] = engine.radius[i];
    temp[i] = engine.surfaceTemp[i];
    ids[i] = engine.ids[i];
    accretion[i] = engine.accretionLuminosity[i];
    const c =
      engine.colors[i * 3] > 0
        ? [engine.colors[i * 3], engine.colors[i * 3 + 1], engine.colors[i * 3 + 2]]
        : (KIND_COLOR[engine.kinds[i]] ?? KIND_COLOR.planet);
    tint[i * 3] = c[0];
    tint[i * 3 + 1] = c[1];
    tint[i * 3 + 2] = c[2];
    const at = engine.atmospheres[i];
    atmos[i * 3] = at ? at.scaleHeight : 0;
    atmos[i * 3 + 1] = at ? at.rayleigh[0] : 0;
    atmos[i * 3 + 2] = at ? at.mie : 0;
    let f = BodyFlags.None;
    const kind = engine.kinds[i];
    if (kind === 'star') f |= BodyFlags.Star;
    if (kind === 'blackhole' || kind === 'neutronstar') f |= BodyFlags.BlackHole;
    if (kind === 'whitedwarf') f |= BodyFlags.Star | BodyFlags.Frozen;
    if (at) f |= BodyFlags.Atmosphere;
    const comp = engine.composition[i];
    if (kind === 'planet' || kind === 'moon' || kind === 'asteroid') {
      if (comp.gas > 0.5) f |= BodyFlags.Gas;
      if (comp.water + comp.ice > 0.35) f |= BodyFlags.Frozen;
      f |= BodyFlags.Rocky;
    }
    if (engine.surfaceTemp[i] > 1100) f |= BodyFlags.Glowing;
    if (engine.isTracer[i]) f |= BodyFlags.Tracer;
    flags[i] = f;
  }
  let particles: RingParticleChunk | null = null;
  if (field.count > 0 && b.particles) {
    const p = b.particles;
    p.positions.set(field.px.subarray(0, field.count * 3));
    p.sizes.set(field.sizes.subarray(0, field.count));
    p.temps.set(field.temps.subarray(0, field.count));
    p.hostIds.set(field.host.subarray(0, field.count));
    p.count = field.count;
    particles = p;
  }
  const d = engine.diagnostics;
  const message: Snapshot = {
    type: 'snapshot',
    seq: seq++,
    simTime: engine.time,
    count: n,
    pos,
    vel,
    radii,
    temp,
    flags,
    tint,
    atmos,
    ids,
    accretion,
    particles,
    diagnostics: {
      simTime: engine.time,
      bodies: n,
      destroyed: engine.destroyedCount,
      kinetic: d.kinetic,
      potential: d.potential,
      total: d.total,
      momentum: d.momentum,
      angularMomentum: d.angularMomentum,
      substeps: d.substeps,
      integrator: engine.params.integrator,
      msPerStep: d.wallMs,
      gridDeformed: detectDeformation(),
      pairCount: d.pairCount,
    },
    selected: buildTelemetry(),
    lagrange: computeLagrange(),
  };
  const transfer: ArrayBuffer[] = [
    pos.buffer as ArrayBuffer,
    vel.buffer as ArrayBuffer,
    radii.buffer as ArrayBuffer,
    temp.buffer as ArrayBuffer,
    flags.buffer as ArrayBuffer,
    tint.buffer as ArrayBuffer,
    atmos.buffer as ArrayBuffer,
    ids.buffer as ArrayBuffer,
    accretion.buffer as ArrayBuffer,
  ];
  if (particles) {
    transfer.push(
      particles.positions.buffer as ArrayBuffer,
      particles.sizes.buffer as ArrayBuffer,
      particles.temps.buffer as ArrayBuffer,
      particles.hostIds.buffer as ArrayBuffer,
    );
  }
  ctx.postMessage(message, transfer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/** Send the name/kind table so the renderer can label bodies without guessing. */
function postRoster(): void {
  const entries = [];
  for (let i = 0; i < engine.count; i++) {
    entries.push({
      id: engine.ids[i],
      name: engine.names[i],
      kind: engine.kinds[i],
      seed: engine.seeds[i] ?? 0,
      mass: engine.mass[i],
      luminosity: engine.luminosity[i],
    });
  }
  ctx.postMessage({ type: 'roster', entries } satisfies WorkerToMain);
}

/** Drain new physics events into the UI ticker. */
let reportedEvents = 0;
function postEvents(): void {
  if (engine.events.length <= reportedEvents) {
    reportedEvents = engine.events.length;
    return;
  }
  for (let i = reportedEvents; i < engine.events.length; i++) {
    const e = engine.events[i];
    const text = describeEvent(e);
    if (text) ctx.postMessage({ type: 'event', kind: e.type, text } satisfies WorkerToMain);
  }
  reportedEvents = engine.events.length;
}

function describeEvent(e: (typeof engine.events)[number]): string | null {
  switch (e.type) {
    case 'roche-disruption':
      return `${e.bodyName} crossed the Roche limit of ${e.primaryName} (d = ${fmtKm(e.radius)} < ${fmtKm(e.rocheRadius)}) and became a debris ring: 2.44 R (ρ_M/ρ_m)^{1/3}.`;
    case 'tidal-disruption':
      return `${e.starName} was spaghettified by ${e.holeName} inside the tidal radius R_t = R★(M_BH/m★)^{1/3} = ${fmtKm(e.tidalRadius)}.`;
    case 'collision':
      return `${e.impactorName} struck ${e.targetName} at ${(e.speed / 1000).toFixed(1)} km/s — Q = ${e.energy.toExponential(2)} J, ΔT = ${e.heatK.toFixed(0)} K${e.fragments ? `, ${e.fragments} fragments ejected` : ''}.`;
    case 'supernova':
      return `${e.name} exploded as a ${e.remnant} (${(e.mass / 1.98847e30).toFixed(2)} M☉); the shock carries ${e.energy.toExponential(2)} J.`;
    case 'escape':
      return `${e.name} reached escape velocity and is leaving ${e.primaryName}'s gravity well at ${(e.speed / 1000).toFixed(2)} km/s.`;
    case 'tidal-locked':
      return `${e.name} tidally locked to ${e.primaryName}: it now keeps one face toward it forever.`;
    case 'message':
      return e.text;
    default:
      return null;
  }
}

/**
 * A complete, self-describing dump of the current state — the raw material for
 * a lab report. Everything is SI, everything the engine knows about a body is
 * included, and it is JSON so it can be read by hand as well as by a script.
 */
function exportState(): string {
  const bodies = [];
  for (let i = 0; i < engine.count; i++) {
    const prim = engine.primaryOfIndex(i);
    bodies.push({
      id: engine.ids[i],
      name: engine.names[i],
      kind: engine.kinds[i],
      mass: engine.mass[i],
      radius: engine.radius[i],
      position: [engine.pos[i * 3], engine.pos[i * 3 + 1], engine.pos[i * 3 + 2]],
      velocity: [engine.vel[i * 3], engine.vel[i * 3 + 1], engine.vel[i * 3 + 2]],
      acceleration: [engine.acc[i * 3], engine.acc[i * 3 + 1], engine.acc[i * 3 + 2]],
      surfaceTemp: engine.surfaceTemp[i],
      equilibriumTemp: engine.equilibriumOf(i),
      luminosity: engine.luminosity[i],
      accretionLuminosity: engine.accretionLuminosity[i],
      albedo: engine.albedo[i],
      greenhouse: engine.greenhouse[i],
      tidalHeating: engine.tidalHeat[i],
      temperature: engine.surfaceTemp[i],
      primary: prim.index >= 0 && prim.index !== i ? engine.names[prim.index] : null,
      distanceToPrimary: prim.distance,
      hillRadius: engine.hillRadiusOf(i),
      rocheLimitFluid: engine.rocheOf(i, false),
      specificOrbitalEnergy: (() => {
        if (prim.index < 0 || prim.index === i) return 0;
        const mu = engine.G * (engine.mass[prim.index] + engine.mass[i]);
        const r = prim.distance;
        const v = Math.hypot(
          engine.vel[i * 3] - engine.vel[prim.index * 3],
          engine.vel[i * 3 + 1] - engine.vel[prim.index * 3 + 1],
          engine.vel[i * 3 + 2] - engine.vel[prim.index * 3 + 2],
        );
        return (v * v) / 2 - mu / r;
      })(),
      tracer: engine.isTracer[i] === 1,
    });
  }
  return JSON.stringify(
    {
      application: 'Cosmoscope',
      generated: new Date().toISOString(),
      preset: currentPreset,
      simulatedTime: engine.time,
      integrator: engine.params.integrator,
      parameters: engine.params,
      diagnostics: engine.diagnostics,
      bodyCount: engine.count,
      destroyed: engine.destroyedCount,
      accretionFuel: engine.accretionFuel(),
      bodies,
    },
    null,
    1,
  );
}

function fmtKm(metres: number): string {
  const km = metres / 1000;
  if (km > 1e6) return `${(km / 1.495978707e8).toFixed(3)} AU`;
  return `${km.toFixed(0)} km`;
}

/** One-click thought experiments. */
function runScenario(name: ScenarioName): void {
  switch (name) {
    case 'sun-to-blackhole': {
      let heaviest = -1;
      for (let i = 0; i < engine.count; i++) {
        if (engine.kinds[i] !== 'star') continue;
        if (heaviest < 0 || engine.mass[i] > engine.mass[heaviest]) heaviest = i;
      }
      if (heaviest >= 0) engine.convertToBlackHole(engine.ids[heaviest], 0.7);
      break;
    }
    case 'jupiter-to-earth-orbit': {
      const earth = findBody((i) => engine.names[i] === 'Earth' || (engine.kinds[i] === 'planet' && engine.mass[i] > 3e24 && engine.mass[i] < 1e25));
      const sun = findBody((i) => engine.kinds[i] === 'star');
      if (earth >= 0 && sun >= 0) {
        const mu = engine.G * engine.mass[sun];
        const r = Math.hypot(engine.pos[earth * 3] - engine.pos[sun * 3], engine.pos[earth * 3 + 1] - engine.pos[sun * 3 + 1], engine.pos[earth * 3 + 2] - engine.pos[sun * 3 + 2]);
        const angle = Math.atan2(engine.pos[earth * 3 + 2] - engine.pos[sun * 3 + 2], engine.pos[earth * 3] - engine.pos[sun * 3]);
        // 30° ahead on the same orbit: not exactly L4, so the perturbation is
        // visible within a few orbits.
        const a2 = angle + Math.PI / 6;
        const v = Math.sqrt(mu / r);
        engine.add({
          id: 0,
          name: 'Jupiter (impostor)',
          kind: 'planet',
          mass: 1.89813e27,
          radius: 6.9911e7,
          pos: [engine.pos[sun * 3] + Math.cos(a2) * r, engine.pos[sun * 3 + 1], engine.pos[sun * 3 + 2] + Math.sin(a2) * r],
          vel: [engine.vel[sun * 3] - Math.sin(a2) * v, engine.vel[sun * 3 + 1], engine.vel[sun * 3 + 2] + Math.cos(a2) * v],
          spinAxis: [0.1, 1, 0.05],
          spinRate: 1.7e-4,
          albedo: 0.5,
          greenhouse: 0.2,
          luminosity: 0,
          internalHeat: 3.35e17,
          surfaceTemp: 165,
          color: [0.78, 0.68, 0.55],
          seed: 991,
          composition: { rock: 0.05, water: 0, ice: 0, gas: 0.92, metal: 0.03 },
          note: 'A gas giant on Earth\u2019s orbit: the Hill sphere is larger than Earth\u2019s, so the inner system is no longer stable.',
        });
      }
      break;
    }
    case 'moon-into-earth': {
      const moon = findBody((i) => engine.kinds[i] === 'moon');
      const earth = findBody((i) => engine.names[i] === 'Earth' || (engine.kinds[i] === 'planet' && engine.mass[i] > 3e24 && engine.mass[i] < 1e25));
      if (moon >= 0 && earth >= 0) {
        // Drop the transverse motion and let gravity do the rest: a free-fall
        // hit about five days later.
        for (let k = 0; k < 3; k++) {
          const d = engine.pos[earth * 3 + k] - engine.pos[moon * 3 + k];
          engine.vel[moon * 3 + k] = engine.vel[earth * 3 + k] + d * 2.3e-6;
        }
        engine.events.push({ type: 'message', text: 'The Moon has been put on a collision course with Earth (impact in a few days of simulated time).' });
      }
      break;
    }
    case 'freeze-moons':
      for (let i = 0; i < engine.count; i++) {
        if (engine.kinds[i] === 'moon' || engine.kinds[i] === 'asteroid') engine.fixed[i] = 1;
      }
      break;
    case 'launch-probe': {
      const earth = findBody((i) => engine.names[i] === 'Earth' || (engine.kinds[i] === 'planet' && engine.mass[i] > 3e24 && engine.mass[i] < 1e25));
      const sun = findBody((i) => engine.kinds[i] === 'star');
      if (earth >= 0 && sun >= 0) {
        const mu = engine.G * engine.mass[sun];
        const rx = engine.pos[earth * 3] - engine.pos[sun * 3];
        const rz = engine.pos[earth * 3 + 2] - engine.pos[sun * 3 + 2];
        const r = Math.hypot(rx, rz);
        // Escape velocity at Earth's orbit, aimed prograde: the probe leaves the
        // Solar System on a hyperbolic trajectory.
        const vEsc = Math.sqrt((2 * mu) / r);
        engine.add({
          id: 0,
          name: 'Escape probe',
          kind: 'asteroid',
          mass: 1e4,
          radius: 5,
          pos: [engine.pos[earth * 3] + (rx / r) * 4e8, engine.pos[earth * 3 + 1], engine.pos[earth * 3 + 2] + (rz / r) * 4e8],
          vel: [engine.vel[earth * 3] - (rz / r) * vEsc * 1.02, 0, engine.vel[earth * 3 + 2] + (rx / r) * vEsc * 1.02],
          spinAxis: [0, 1, 0],
          spinRate: 0,
          albedo: 0.6,
          greenhouse: 0,
          luminosity: 0,
          internalHeat: 0,
          surfaceTemp: 280,
          color: [0.9, 0.9, 0.95],
          seed: 777,
          composition: { rock: 0.85, water: 0, ice: 0, gas: 0, metal: 0.15 },
          note: 'Launched at 1.02 x escape velocity — a hyperbolic orbit. Watch the specific orbital energy turn positive.',
        });
      }
      break;
    }
    case 'reset':
      loadPreset(currentPreset, undefined);
      reportedEvents = 0;
      return;
  }
  engine.recomputeForces();
  engine.updateDiagnostics();
  rebuildParticles();
  postRoster();
  snapshot();
}

function findBody(predicate: (i: number) => boolean): number {
  for (let i = 0; i < engine.count; i++) if (predicate(i)) return i;
  return -1;
}

let currentPreset = 'solar-system';
let degraded = false;

/**
 * Tell the UI when the requested time warp exceeds what the integrator can
 * resolve in one frame — the honest thing to do rather than silently producing
 * garbage trajectories at 1 Myr/s.
 */
function pushDiagnosticsPatch(): void {
  if (degraded !== lastDegraded) {
    lastDegraded = degraded;
    ctx.postMessage({ type: 'diagnostics', degraded } satisfies WorkerToMain);
  }
}
let lastDegraded = false;

function handleAdvance(dt: number, maxSteps: number): void {
  if (dt === 0 || engine.count === 0) {
    updateParticles(0);
    snapshot();
    return;
  }
  const t0 = performance.now();
  const budgetMs = 22;
  const sign = Math.sign(dt);
  let remaining = Math.abs(dt);
  let steps = 0;
  // Let the engine decide how finely this interval has to be integrated, then
  // cap the work per frame so a 1 Myr warp cannot lock up the thread.
  const planned = engine.planSteps(Math.abs(dt));
  const total = Math.min(Math.max(planned, 1), Math.max(maxSteps, 1));
  degraded = planned > total;
  const hNominal = remaining / total;
  while (remaining > 0 && steps < total) {
    const h = Math.min(remaining, Math.max(hNominal, Math.abs(dt) * 1e-6)) * sign;
    engine.step(h);
    updateParticles(h);
    remaining -= Math.abs(h);
    steps++;
    if (performance.now() - t0 > budgetMs) break;
  }
  engine.diagnostics.wallMs = (performance.now() - t0) / Math.max(steps, 1);
  postEvents();
  pushDiagnosticsPatch();
  snapshot();
}

function applyWhatIf(key: 'G' | 'c' | 'radiationPressure' | 'solarLuminosity', value: number): void {
  switch (key) {
    case 'G':
      engine.params.GScale = value;
      engine.recomputeForces();
      break;
    case 'c':
      engine.params.cScale = value;
      engine.recomputeForces();
      break;
    case 'radiationPressure':
      engine.setRadiationPressure(value);
      break;
    case 'solarLuminosity':
      engine.scaleLuminosity(value);
      break;
  }
  engine.updateDiagnostics();
  snapshot();
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        loadPreset(msg.presetId, msg.params);
        rebuildParticles();
        reportedEvents = 0;
        postRoster();
        engine.updateDiagnostics();
        snapshot();
        break;
      case 'advance':
        handleAdvance(msg.dt, msg.maxSteps);
        break;
      case 'scenario':
        runScenario(msg.name);
        break;
      case 'setParams':
        engine.params = { ...engine.params, ...msg.params };
        engine.recomputeForces();
        break;
      case 'spawn':
        engine.add(msg.body);
        rebuildParticles();
        postRoster();
        engine.updateDiagnostics();
        snapshot();
        break;
      case 'spawnMany':
        for (const b of msg.bodies) engine.add(b, true);
        rebuildParticles();
        postRoster();
        engine.updateDiagnostics();
        snapshot();
        break;
      case 'remove':
        engine.removeById(msg.id);
        rebuildParticles();
        engine.updateDiagnostics();
        snapshot();
        break;
      case 'select':
        selectedId = msg.id;
        break;
      case 'focus':
        focusId = msg.id;
        if (msg.id >= 0 && engine.indexOfId(msg.id) < 0) focusId = -1;
        snapshot();
        break;
      case 'collapse': {
        const event = engine.collapseStar(msg.id);
        if (event) rebuildParticles();
        engine.updateDiagnostics();
        snapshot();
        break;
      }
      case 'lagrange':
        lagrangePair =
          engine.indexOfId(msg.primary) >= 0 && engine.indexOfId(msg.secondary) >= 0
            ? [msg.primary, msg.secondary]
            : null;
        snapshot();
        break;
      case 'whatIf':
        applyWhatIf(msg.key, msg.value);
        break;
      case 'exportState':
        ctx.postMessage({ type: 'state', json: exportState() } satisfies WorkerToMain);
        break;
      case 'recycle':
        recycle(msg as unknown as SnapshotBuffers);
        break;
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    } satisfies WorkerToMain);
  }
};
