/**
 * Message protocol between the main thread (renderer + UI) and the physics
 * worker.  Everything that crosses the boundary is either a plain JSON-ish
 * command or a transferable buffer, so the physics loop never blocks on the
 * render loop.
 */

import type { PhysicsParams } from '../physics/PhysicsEngine';
import type { BodySpec } from '../physics/CelestialBody';

/** Per-body render flags, packed into one byte. */
export const enum BodyFlags {
  None = 0,
  Star = 1 << 0,
  BlackHole = 1 << 1,
  Atmosphere = 1 << 2,
  Rocky = 1 << 3,
  Gas = 1 << 4,
  Frozen = 1 << 5,
  Tracer = 1 << 6,
  Glowing = 1 << 7,
}

export interface ElementTelemetry {
  a: number;
  e: number;
  i: number;
  argPeriapsis: number;
  ascendingNode: number;
  trueAnomaly: number;
  period: number;
  apoapsis: number;
  periapsis: number;
  speed: number;
  escapeSpeed: number;
  circularSpeed: number;
  meanMotion: number;
  bound: boolean;
  hillRadius: number;
  rocheFluid: number;
  rocheRigid: number;
  specificEnergy: number;
  angularMomentum: number;
}

export interface BodyTelemetry {
  id: number;
  name: string;
  kind: string;
  mass: number;
  radius: number;
  luminosity: number;
  surfaceTemp: number;
  equilibriumTemp: number;
  greenhouse: number;
  albedo: number;
  tidalHeating: number;
  /** Accretion luminosity, W, and the fraction of the Eddington limit. */
  accretion: number;
  eddingtonFraction: number;
  /** Mass still waiting to be radiated, kg. */
  accretionFuel: number;
  primaryName: string;
  axialTilt: number;
  spinPeriod: number;
  composition: string;
  atmosphere: { scaleHeight: number; betaR: number; betaM: number; top: number } | null;
  ring: { innerRadius: number; outerRadius: number; opacity: number } | null;
  elements: ElementTelemetry | null;
  pos: [number, number, number];
  vel: [number, number, number];
  acc: [number, number, number];
  force: [number, number, number];
  distanceToPrimary: number;
}

export interface Diagnostics {
  simTime: number;
  bodies: number;
  destroyed: number;
  kinetic: number;
  potential: number;
  total: number;
  momentum: [number, number, number];
  angularMomentum: [number, number, number];
  substeps: number;
  integrator: string;
  msPerStep: number;
  gridDeformed: boolean;
  pairCount: number;
}

export interface RingParticleChunk {
  /** xyz triplets, body-space metres, offset from the host body's centre. */
  positions: Float32Array;
  sizes: Float32Array;
  temps: Float32Array;
  count: number;
  hostIds: Int32Array;
}

export interface Snapshot {
  type: 'snapshot';
  seq: number;
  simTime: number;
  count: number;
  /** Reusable-but-transferable arrays; the main thread hands them back. */
  pos: Float32Array;
  vel: Float32Array;
  radii: Float32Array;
  temp: Float32Array;
  flags: Uint8Array;
  tint: Float32Array;
  atmos: Float32Array;
  ids: Int32Array;
  /** Accretion luminosity per body, W (0 for everything that is not feeding). */
  accretion: Float32Array;
  particles: RingParticleChunk | null;
  diagnostics: Diagnostics;
  selected: BodyTelemetry | null;
  lagrange: { id: string; pos: [number, number, number] }[] | null;
}

export type MainToWorker =
  | { type: 'init'; presetId: string; params?: Partial<PhysicsParams>; capacity?: number }
  | { type: 'advance'; dt: number; maxSteps: number }
  | { type: 'setParams'; params: Partial<PhysicsParams> }
  | { type: 'spawn'; body: BodySpec }
  | { type: 'spawnMany'; bodies: BodySpec[] }
  | { type: 'remove'; id: number }
  | { type: 'select'; id: number }
  | { type: 'focus'; id: number }
  | { type: 'collapse'; id: number }
  | { type: 'lagrange'; primary: number; secondary: number }
  | { type: 'whatIf'; key: 'G' | 'c' | 'radiationPressure' | 'solarLuminosity'; value: number }
  | { type: 'scenario'; name: ScenarioName }
  | { type: 'recycle'; pos: Float32Array; vel: Float32Array; radii: Float32Array; temp: Float32Array; flags: Uint8Array; tint: Float32Array; atmos: Float32Array; ids: Int32Array; accretion: Float32Array; particles: RingParticleChunk | null }
  | { type: 'exportState' };

export type ScenarioName =
  | 'sun-to-blackhole'
  | 'jupiter-to-earth-orbit'
  | 'moon-into-earth'
  | 'freeze-moons'
  | 'launch-probe'
  | 'reset';

export interface RosterEntry {
  id: number;
  name: string;
  kind: string;
  seed: number;
  /** Mass in kg — used for the curvature grid and primary selection. */
  mass: number;
  /** Photospheric luminosity in W (0 for non-luminous bodies). */
  luminosity: number;
}

export type WorkerToMain =
  | {
      type: 'ready';
      presetId: string;
      name: string;
      lesson: string;
      watchFor: string[];
      camera: { focus: string; distance: number; elevation: number };
      timeWarp: number;
      overlays: string[];
      count: number;
    }
  | { type: 'roster'; entries: RosterEntry[] }
  | { type: 'event'; kind: string; text: string; detail?: string }
  | { type: 'diagnostics'; degraded: boolean }
  | { type: 'state'; json: string }
  | { type: 'error'; message: string }
  | Snapshot;
