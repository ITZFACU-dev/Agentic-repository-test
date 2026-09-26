/**
 * Scene manager — the bridge from physics snapshots to GPU state.
 *
 * Everything here is allocation-free in the steady state: one snapshot in, a
 * handful of buffer uploads out. It also owns the "who is the star?" decision
 * (the dominant light source), the compact-object list handed to the lensing
 * pass, and body picking for the inspector.
 */

import * as THREE from 'three';
import { BodyRenderer } from './BodyRenderer';
import { Starfield } from './Starfield';
import { CurvatureGrid } from './CurvatureGrid';
import { OverlayRenderer } from './OverlayRenderer';
import { Labels, type LabelRequest } from './Labels';
import { HDRPipeline, type LensUniform } from './HDRPipeline';
import { CameraRig } from './CameraRig';
import { BodyFlags, type RosterEntry, type Snapshot } from '../sim/protocol';
import { AU, PARSEC, blackbodyColor } from '../core/units';
import { clamp } from '../core/mathx';

export type { RosterEntry } from '../sim/protocol';

export interface SceneOptions {
  showLabels: boolean;
  showTrails: boolean;
  showGrid: boolean;
  showHabitability: boolean;
  showVectors: boolean;
  exaggeration: number;
  atmosphereQuality: 'low' | 'medium' | 'high';
}

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly bodies: BodyRenderer;
  readonly starfield: Starfield;
  readonly grid: CurvatureGrid;
  readonly overlays: OverlayRenderer;
  readonly labels: Labels;

  private roster = new Map<number, RosterEntry>();
  private lensCache: LensUniform[] = [];
  private starPosition = new THREE.Vector3();
  private starColor = new THREE.Color(1, 1, 1);
  private starIntensity = 1;
  private gridTimer = 0;
  private lastSnapshot: Snapshot | null = null;
  private hoverId = -1;
  selectedId = -1;
  time = 0;

  options: SceneOptions = {
    showLabels: true,
    showTrails: true,
    showGrid: false,
    showHabitability: false,
    showVectors: true,
    exaggeration: 1,
    atmosphereQuality: 'high',
  };

  constructor(pipeline: HDRPipeline, labelsHost: HTMLElement) {
    this.scene.background = null;
    this.bodies = new BodyRenderer(768);
    this.starfield = new Starfield();
    this.grid = new CurvatureGrid();
    this.overlays = new OverlayRenderer();
    this.labels = new Labels(labelsHost);
    this.scene.add(this.starfield.mesh, this.bodies.group, this.overlays.group, this.grid.mesh);
    void pipeline;
    this.applyAtmosphereQuality('high');
  }

  setRoster(entries: RosterEntry[]): void {
    this.roster.clear();
    for (const e of entries) this.roster.set(e.id, e);
  }

  /** Everything the engine knows about each body, keyed by id (mass, luminosity). */
  get rosterEntries(): Map<number, RosterEntry> {
    return this.roster;
  }

  nameOf(id: number): string {
    return this.roster.get(id)?.name ?? `body ${id}`;
  }

  kindOf(id: number): string {
    return this.roster.get(id)?.kind ?? 'unknown';
  }

  applyAtmosphereQuality(quality: SceneOptions['atmosphereQuality']): void {
    this.options.atmosphereQuality = quality;
    if (quality === 'low') this.bodies.setAtmosphereQuality(6, 3, 1);
    else if (quality === 'medium') this.bodies.setAtmosphereQuality(10, 5, 1);
    else this.bodies.setAtmosphereQuality(14, 7, 1);
  }

  // ── Snapshot ingestion ────────────────────────────────────────────────────

  applySnapshot(snapshot: Snapshot, dt: number, rig: CameraRig): void {
    this.lastSnapshot = snapshot;
    this.time += dt;
    this.bodies.setExaggeration(this.options.exaggeration);

    // 1. Choose the dominant light source: the most luminous body present.
    let bestLum = -1;
    let starIndex = -1;
    for (let i = 0; i < snapshot.count; i++) {
      const flags = snapshot.flags[i];
      if ((flags & BodyFlags.Star) === 0) continue;
      // Brightness on screen: luminosity diluted by distance from the camera.
      const dx = snapshot.pos[i * 3] - rig.cameraPosition.x;
      const dy = snapshot.pos[i * 3 + 1] - rig.cameraPosition.y;
      const dz = snapshot.pos[i * 3 + 2] - rig.cameraPosition.z;
      const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1);
      const score = snapshot.radii[i] ** 2 * snapshot.temp[i] ** 4 / d2;
      if (score > bestLum) {
        bestLum = score;
        starIndex = i;
      }
    }
    if (starIndex >= 0) {
      this.starPosition.set(snapshot.pos[starIndex * 3], snapshot.pos[starIndex * 3 + 1], snapshot.pos[starIndex * 3 + 2]);
      const [sr, sg, sb] = blackbodyColor(snapshot.temp[starIndex]);
      this.starColor.setRGB(sr, sg, sb);
      this.starIntensity = clamp(1.6 + Math.log10(Math.max(snapshot.radii[starIndex], 1) * 1e2), 0.6, 4);
    } else {
      // Deep space: a dim ambient so nothing is pitch black.
      this.starColor.setRGB(0.6, 0.65, 0.8);
      this.starIntensity = 0.25;
    }
    this.bodies.setSun(this.starPosition, this.starColor, this.starIntensity);

    // 2. Bodies and ring particles.
    this.bodies.update(snapshot, dt);
    this.bodies.updateParticles(snapshot.particles, snapshot.pos);

    // 3. Compact objects → lensing + accretion disks.
    this.lensCache.length = 0;
    for (let i = 0; i < snapshot.count; i++) {
      const flags = snapshot.flags[i];
      const kind = this.kindOf(snapshot.ids[i]);
      const compact = (flags & BodyFlags.BlackHole) !== 0 || kind === 'whitedwarf';
      if (!compact) continue;
      const radius = snapshot.radii[i];
      if (radius <= 0) continue;
      const rs = radius; // compact bodies are drawn at their Schwarzschild radius
      const hasDisk = kind === 'blackhole';
      this.lensCache.push({
        position: new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]),
        rs: rs * (kind === 'neutronstar' ? 0.35 : 1),
        strength: kind === 'neutronstar' ? 0.25 : 1,
        axis: new THREE.Vector3(0, 1, 0),
        diskStrength: hasDisk ? 1 : 0,
        diskOuter: rs * 14,
        diskTemp: 16000,
        diskColor: new THREE.Color(1.0, 0.82, 0.62),
      });
    }

    // 4. Trails for the bodies we care about.
    this.overlays.trailLength = clamp(Math.round(220 + 900 / Math.max(this.options.exaggeration, 0.1)), 120, 2200);
    if (this.options.showTrails) {
      const selected = this.selectedId >= 0 ? this.selectedId : snapshot.diagnostics.bodies <= 12 ? snapshot.ids[0] : -1;
      for (let i = 0; i < snapshot.count; i++) {
        const id = snapshot.ids[i];
        const wanted = snapshot.count <= 12 || id === selected;
        if (!wanted) continue;
        if ((snapshot.flags[i] & BodyFlags.Tracer) !== 0) continue;
        const [tr, tg, tb] = blackbodyColor(snapshot.temp[i]);
        this.overlays.addTrail(id, new THREE.Color(tr, tg, tb).multiplyScalar(0.9));
        this.overlays.pushTrail(id, new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]));
      }
    }

    // 5. Habitable-zone ribbons.
    if (this.options.showHabitability) {
      const stars: { position: THREE.Vector3; luminosity: number; axis: THREE.Vector3 }[] = [];
      for (let i = 0; i < snapshot.count; i++) {
        if ((snapshot.flags[i] & BodyFlags.Star) === 0) continue;
        // Real luminosity from the roster; fall back to 4πR²σT⁴ if unknown.
        const entry = this.roster.get(snapshot.ids[i]);
        const r = snapshot.radii[i];
        const t = snapshot.temp[i];
        const luminosity = entry && entry.luminosity > 0 ? entry.luminosity : 4 * Math.PI * r * r * 5.670374419e-8 * t ** 4;
        stars.push({
          position: new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]),
          luminosity,
          axis: new THREE.Vector3(0, 1, 0),
        });
      }
      this.overlays.setHabitableZones(stars);
    }

    // 6. Spacetime grid: refresh at ~8 Hz, it is a heavy vertex workload.
    this.gridTimer += dt;
    if (this.options.showGrid && this.gridTimer > 0.12) {
      this.gridTimer = 0;
      const bodies: { id: number; position: THREE.Vector3; mass: number; compact: boolean }[] = [];
      let span = AU * 40;
      for (let i = 0; i < snapshot.count; i++) {
        if (snapshot.radii[i] <= 0) continue;
        const entry = this.roster.get(snapshot.ids[i]);
        const compact = (snapshot.flags[i] & BodyFlags.BlackHole) !== 0;
        const mass = entry?.mass ?? 1e20;
        bodies.push({
          id: snapshot.ids[i],
          position: new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]),
          mass,
          compact,
        });
        const dist = new THREE.Vector3(snapshot.pos[i * 3] - rig.cameraPosition.x, snapshot.pos[i * 3 + 1] - rig.cameraPosition.y, snapshot.pos[i * 3 + 2] - rig.cameraPosition.z).length();
        span = Math.max(span, Math.min(dist * 6, PARSEC * 1e4));
      }
      if (this.grid.gridSpan !== span) this.grid.setSpan(span);
      this.grid.setBodies(bodies);
    }

    // 7. Labels.
    const labelRequests: LabelRequest[] = [];
    for (let i = 0; i < snapshot.count; i++) {
      const id = snapshot.ids[i];
      const flags = snapshot.flags[i];
      const important = (flags & (BodyFlags.Star | BodyFlags.BlackHole)) !== 0 || id === this.selectedId || id === this.hoverId;
      if (!this.options.showLabels) break;
      if (!important && snapshot.count > 40) continue;
      labelRequests.push({
        key: `b${id}`,
        text: this.nameOf(id),
        position: new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]),
        kind: (flags & (BodyFlags.Star | BodyFlags.BlackHole)) !== 0 ? 'hazard' : 'body',
        selected: id === this.selectedId,
        radius: snapshot.radii[i],
      });
    }
    for (const marker of this.overlays.lagrangeMarkers) {
      labelRequests.push({ key: `L${marker.label}`, text: marker.label, position: marker.position, kind: 'lagrange' });
    }
    this.labels.enabled = this.options.showLabels;
    this.pendingLabels = labelRequests;
  }

  private pendingLabels: LabelRequest[] = [];

  /** Per-frame GPU uniform + screen-space update. */
  updateFrame(rig: CameraRig, pipeline: HDRPipeline, width: number, height: number): void {
    const vp = rig.viewProjection;
    const camPos = rig.cameraPosition;
    this.starfield.setViewProjection(rig.camera.projectionMatrix);
    // The sky sphere is centred on the camera by construction: the vertex
    // shader uses the rotation-only view matrix, so it behaves like a skybox
    // at infinity and never clips.
    this.bodies.setCameraUniforms(vp, camPos, this.time);
    this.grid.setCameraUniforms(vp, camPos, this.time);
    this.grid.setVisible(this.options.showGrid);
    this.overlays.setCameraUniforms(vp, camPos, this.time);
    this.overlays.setTrailsVisible(this.options.showTrails);

    const snapshot = this.lastSnapshot;
    if (snapshot) {
      const telemetry = snapshot.selected;
      if (telemetry && this.options.showVectors) {
        const pos = new THREE.Vector3(telemetry.pos[0], telemetry.pos[1], telemetry.pos[2]);
        const vel = new THREE.Vector3(telemetry.vel[0], telemetry.vel[1], telemetry.vel[2]);
        const acc = new THREE.Vector3(telemetry.acc[0], telemetry.acc[1], telemetry.acc[2]);
        const force = new THREE.Vector3(telemetry.force[0], telemetry.force[1], telemetry.force[2]);
        this.overlays.setVectors(pos, vel, acc, force, Math.max(telemetry.radius * 6, 1e6));
      } else {
        this.overlays.hideVectors();
      }

      // Osculating Kepler ellipse of the selected body, drawn around whichever
      // body dominates its motion (its actual primary if the engine named one,
      // otherwise the dominant star).
      if (telemetry?.elements) {
        const primaryPos = this.primaryPosition(telemetry.id);
        this.overlays.setKeplerOrbit(primaryPos, telemetry.elements);
      } else {
        this.overlays.setKeplerOrbit(new THREE.Vector3(), null);
      }

      pipeline.setLenses(this.lensCache);
      this.overlays.setLagrange(snapshot.lagrange, rig.distance);
    }

    this.labels.update(this.pendingLabels, rig.camera, width, height);
  }

  /**
   * The position of the body that dominates the selected body's motion: the
   * most massive candidate, weighted by the inverse square of the distance, so
   * a moon picks its planet and a planet picks its star.
   */
  primaryPosition(id: number): THREE.Vector3 {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return new THREE.Vector3();
    let selfIndex = -1;
    for (let i = 0; i < snapshot.count; i++) if (snapshot.ids[i] === id) selfIndex = i;
    if (selfIndex < 0) return new THREE.Vector3();
    const px = snapshot.pos[selfIndex * 3];
    const py = snapshot.pos[selfIndex * 3 + 1];
    const pz = snapshot.pos[selfIndex * 3 + 2];
    let bestScore = 0;
    let best = -1;
    for (let i = 0; i < snapshot.count; i++) {
      if (i === selfIndex) continue;
      const entry = this.roster.get(snapshot.ids[i]);
      const mass = entry?.mass ?? 0;
      if (mass <= 0) continue;
      const dx = snapshot.pos[i * 3] - px;
      const dy = snapshot.pos[i * 3 + 1] - py;
      const dz = snapshot.pos[i * 3 + 2] - pz;
      const r2 = Math.max(dx * dx + dy * dy + dz * dz, 1);
      // A body only counts as a primary if it is more massive than the child.
      const selfMass = this.roster.get(id)?.mass ?? 0;
      if (mass <= selfMass) continue;
      const score = mass / r2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) {
      // Fall back to the dominant star.
      return this.starPosition.clone();
    }
    return new THREE.Vector3(snapshot.pos[best * 3], snapshot.pos[best * 3 + 1], snapshot.pos[best * 3 + 2]);
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  /** Screen-space picking: project every body and take the closest hit. */
  pick(x: number, y: number, rig: CameraRig, width: number, height: number): number {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return -1;
    const v = new THREE.Vector3();
    let best = -1;
    let bestScore = Infinity;
    const halfFov = Math.tan((rig.camera.fov * Math.PI) / 360);
    for (let i = 0; i < snapshot.count; i++) {
      v.set(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]).project(rig.camera);
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height;
      const dx = sx - x;
      const dy = sy - y;
      const dist = Math.hypot(dx, dy);
      const worldDist = rig.cameraPosition.distanceTo(new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]));
      const angular = (snapshot.radii[i] / Math.max(worldDist, 1)) / halfFov * (height / 2);
      const threshold = Math.max(6, angular * 1.4);
      if (dist > threshold) continue;
      // Prefer the nearest body among the candidates under the cursor.
      if (worldDist < bestScore) {
        bestScore = worldDist;
        best = snapshot.ids[i];
      }
    }
    return best;
  }

  setHover(id: number): void {
    this.hoverId = id;
  }

  /** Position and radius of a body, for camera follow. */
  lookup(id: number): { position: THREE.Vector3; radius: number } | null {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return null;
    for (let i = 0; i < snapshot.count; i++) {
      if (snapshot.ids[i] !== id) continue;
      return {
        position: new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]),
        radius: snapshot.radii[i],
      };
    }
    return null;
  }

  findIndex(id: number): number {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return -1;
    return snapshot.ids.indexOf(id);
  }

  get snapshot(): Snapshot | null {
    return this.lastSnapshot;
  }

  /** Focus framing helper used when a preset loads. */
  focusByName(rig: CameraRig, name: string, distance: number): boolean {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return false;
    for (const [id, entry] of this.roster) {
      if (entry.name.toLowerCase() !== name.toLowerCase()) continue;
      const i = snapshot.ids.indexOf(id);
      if (i < 0) continue;
      rig.focusOn(id, new THREE.Vector3(snapshot.pos[i * 3], snapshot.pos[i * 3 + 1], snapshot.pos[i * 3 + 2]), snapshot.radii[i], 6);
      rig.setFraming(distance);
      return true;
    }
    return false;
  }

  /** Clear per-preset state (trails, selection, lens list). */
  reset(): void {
    this.overlays.clearTrails();
    this.selectedId = -1;
    this.lensCache.length = 0;
    this.lastSnapshot = null;
    this.pendingLabels = [];
    this.labels.clear();
  }
}
