/**
 * Application shell.
 *
 * Wiring, in one direction only:
 *
 *      worker (physics)  ──snapshot──▶  SceneManager ──▶ GPU
 *             ▲                              │
 *             └──── commands ────  UI ◀───────┘
 *
 * The render loop never waits for the physics loop: it requests an advance,
 * draws the most recent snapshot, and applies the next one when it arrives.
 * That is what "physics decoupled from rendering" means in practice.
 */

import { HDRPipeline } from '../render/HDRPipeline';
import { SceneManager } from '../render/SceneManager';
import { CameraRig } from '../render/CameraRig';
import { HUD } from './HUD';
import { Inspector } from './Inspector';
import { LeftPanel, TimeBar, type OverlayName, type PipelineName, type UiActions } from './Panels';
import type { MainToWorker, Snapshot, WorkerToMain } from '../sim/protocol';
import type { PhysicsParams } from '../physics/PhysicsEngine';
import { WARP_LADDER } from './dom';
import { clamp } from '../core/mathx';

export class App {
  private pipeline: HDRPipeline;
  private scene: SceneManager;
  private rig: CameraRig;
  private hud: HUD;
  private inspector: Inspector;
  private left: LeftPanel;
  private timebar: TimeBar;
  private worker: Worker;
  private canvas: HTMLCanvasElement;
  private root: HTMLElement;

  private warp = 60;
  private paused = false;
  private reversed = false;
  private inFlight = false;
  private pendingDt = 0;
  private lastFrame = performance.now();
  private drift = 0;
  /** Set when the engine cannot resolve the requested time warp. */
  degraded = false;
  private presetId = '';
  private lastSnapshotAt = 0;
  private graphTimer = 0;

  private actions: UiActions;

  constructor(root: HTMLElement) {
    this.root = root;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'view';
    root.appendChild(this.canvas);

    this.pipeline = new HDRPipeline(this.canvas);
    this.scene = new SceneManager(this.pipeline, root);
    this.rig = new CameraRig(this.canvas);
    this.hud = new HUD(root);
    this.inspector = new Inspector(root);

    this.actions = {
      paused: false,
      loadPreset: (id) => this.loadPreset(id),
      setParams: (params) => this.setParams(params),
      whatIf: (key, value) => this.post({ type: 'whatIf', key, value }),
      scenario: (name) => {
        if (name === 'reset') {
          // A full re-init: the engine reloads the preset, and the UI clears
          // its history at the same time.
          this.loadPreset(this.presetId || 'solar-system');
          return;
        }
        this.post({ type: 'scenario', name });
      },
      overlay: (option, value) => this.setOverlay(option, value),
      pipeline: (option, value) => this.setPipeline(option, value),
      setWarp: (warp) => {
        this.warp = Math.max(Math.abs(warp), 1);
      },
      setPaused: (paused) => {
        this.paused = paused;
        this.actions.paused = paused;
      },
      stepOnce: () => this.post({ type: 'advance', dt: this.warp > 1 ? 60 : 1, maxSteps: 8 }),
      toggleReverse: () => {
        this.reversed = !this.reversed;
      },
    };
    this.left = new LeftPanel(root, this.actions);
    this.timebar = new TimeBar(root, this.actions);

    this.worker = new Worker(new URL('../workers/physics.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onWorkerMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.hud.pushEvent(`physics worker error: ${ev.message}`, true);
      console.error(ev);
    };

    this.buildHelp();
    this.bindInteraction();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.loadPreset('solar-system');
    requestAnimationFrame(() => this.frame());
  }


  // ── Worker plumbing ───────────────────────────────────────────────────────

  private post(message: MainToWorker, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }

  private loadPreset(id: string): void {
    this.presetId = id;
    this.paused = false;
    this.actions.paused = false;
    this.timebar.syncPlayIcon();
    this.inspector.energy.reset();
    this.scene.reset();
    this.hud.clearEvents();
    this.left.markPreset(id);
    this.post({ type: 'init', presetId: id });
  }

  private setParams(params: Partial<PhysicsParams>): void {
    this.post({ type: 'setParams', params });
  }

  private setOverlay(option: OverlayName, value: boolean | number | string): void {
    switch (option) {
      case 'labels':
        this.scene.options.showLabels = Boolean(value);
        break;
      case 'trails':
        this.scene.options.showTrails = Boolean(value);
        if (!value) this.scene.overlays.clearTrails();
        break;
      case 'grid':
        this.scene.options.showGrid = Boolean(value);
        break;
      case 'habitability':
        this.scene.options.showHabitability = Boolean(value);
        break;
      case 'vectors':
        this.scene.options.showVectors = Boolean(value);
        this.scene.overlays.showVelocity = Boolean(value);
        this.scene.overlays.showForce = Boolean(value);
        this.scene.overlays.showAccel = Boolean(value);
        break;
      case 'accretion':
        this.scene.options.showAccretion = Boolean(value);
        break;
      case 'lagrange': {
        this.scene.overlays.showLagrange = Boolean(value);
        const ranked = [...this.scene.rosterEntries.values()].sort((a, b) => b.mass - a.mass);
        if (value && ranked.length >= 2) {
          this.post({ type: 'lagrange', primary: ranked[0].id, secondary: ranked[1].id });
        } else {
          this.post({ type: 'lagrange', primary: -1, secondary: -1 });
          this.scene.overlays.setLagrange(null, 1);
        }
        break;
      }
      case 'exaggeration':
        this.scene.options.exaggeration = Number(value);
        break;
      case 'atmosphereDensity':
        this.atmosphereOptics.density = Number(value);
        this.applyAtmosphereOptics();
        break;
      case 'atmosphereBetaR':
        this.atmosphereOptics.betaR = Number(value);
        this.applyAtmosphereOptics();
        break;
      case 'atmosphereBetaM':
        this.atmosphereOptics.betaM = Number(value);
        this.applyAtmosphereOptics();
        break;
      case 'atmosphereQuality':
        this.scene.applyAtmosphereQuality(value as 'low' | 'medium' | 'high');
        break;
    }
  }

  private atmosphereOptics = { density: 1, betaR: 1, betaM: 1 };

  private applyAtmosphereOptics(): void {
    const { density, betaR, betaM } = this.atmosphereOptics;
    this.scene.applyAtmosphereQuality(this.scene.options.atmosphereQuality);
    this.scene.bodies.setAtmosphereOptics(betaR, betaM);
    this.scene.bodies.setAtmosphereQuality(
      this.scene.options.atmosphereQuality === 'low' ? 6 : this.scene.options.atmosphereQuality === 'medium' ? 10 : 14,
      this.scene.options.atmosphereQuality === 'low' ? 3 : this.scene.options.atmosphereQuality === 'medium' ? 5 : 7,
      density,
    );
  }

  private setPipeline(option: PipelineName, value: boolean | number): void {
    const t = this.pipeline.toggles;
    switch (option) {
      case 'bloom':
        t.bloom = Boolean(value);
        break;
      case 'eyeAdaptation':
        t.eyeAdaptation = Boolean(value);
        break;
      case 'lensing':
        t.lensing = Boolean(value);
        break;
      case 'bloomStrength':
        t.bloomStrength = Number(value);
        break;
      case 'exposureBias':
        t.exposureBias = Number(value);
        break;
      case 'chromatic':
        t.chromatic = Number(value);
        break;
    }
  }

  private onWorkerMessage(message: WorkerToMain): void {
    switch (message.type) {
      case 'ready': {
        const warp = message.timeWarp;
        this.warp = Math.abs(warp) || 1;
        this.actions.setWarp(this.warp);
        this.timebar.setWarp(this.warp);
        this.left.showLesson(message.name, message.lesson, message.watchFor);
        this.pendingCamera = message.camera;
        // Presets declare which teaching overlays matter for their lesson.
        for (const overlay of message.overlays) {
          switch (overlay) {
            case 'potential':
              this.actions.overlay('grid', true);
              break;
            case 'habitable':
              this.actions.overlay('habitability', true);
              break;
            case 'vectors':
              this.actions.overlay('vectors', true);
              break;
            case 'trails':
            case 'roche':
            case 'lyapunov':
            case 'kepler':
              this.actions.overlay('trails', true);
              break;
            case 'lens':
              this.setPipeline('lensing', true);
              this.actions.overlay('accretion', true);
              break;
          }
        }
        break;
      }
      case 'roster': {
        this.scene.setRoster(message.entries);
        // Frame and select the body the lab is about, so the inspector is
        // populated the moment the preset appears rather than after a click.
        const camera = this.pendingCamera;
        if (camera && camera.focus) {
          const entry = message.entries.find((e) => e.name.toLowerCase() === camera.focus.toLowerCase());
          if (entry) {
            this.selectedId = entry.id;
            this.scene.selectedId = entry.id;
            this.post({ type: 'select', id: entry.id });
            this.post({ type: 'focus', id: entry.id });
            // The camera can only lock on once a snapshot has given us the
            // body's position, so arm it here and let applySnapshot fire.
            this.pendingFollow = entry.id;
            this.rig.setFraming(camera.distance, camera.elevation);
          }
        }
        this.pendingCamera = null;
        break;
      }
      case 'snapshot':
        this.applySnapshot(message);
        break;
      case 'event':
        this.hud.pushEvent(message.text, message.kind === 'collision' || message.kind === 'supernova');
        break;
      case 'diagnostics':
        this.degraded = message.degraded;
        this.hud.setDegraded(message.degraded);
        break;
      case 'error':
        this.hud.pushEvent(`physics error: ${message.message.split('\n')[0]}`, true);
        console.error(message.message);
        break;
    }
  }

  private pendingCamera: { focus: string; distance: number; elevation: number } | null = null;
  /** Body the camera should lock onto as soon as its position is known. */
  private pendingFollow = -1;
  private recycleQueue: {
    pos: Float32Array;
    vel: Float32Array;
    radii: Float32Array;
    temp: Float32Array;
    flags: Uint8Array;
    tint: Float32Array;
    atmos: Float32Array;
    ids: Int32Array;
    particles: Snapshot['particles'];
  }[] = [];

  private applySnapshot(snapshot: Snapshot): void {
    // Wall-clock delta since the previous snapshot, clamped: at a 1 Myr/s warp
    // the raw value would be 10¹⁰ s and every shader animation would snap.
    const dt = clamp(snapshot.simTime - this.lastSnapshotAt, 0, 0.25);
    // Body motion is interpolated in the renderer, not delayed here: draw the
    // newest state we have, immediately.
    this.scene.selectedId = this.selectedId;
    this.scene.applySnapshot(snapshot, Math.max(dt, 0), this.rig);
    this.inspector.update(
      snapshot.selected,
      snapshot.selected ? this.scene.nameOf(this.primaryIdFor(snapshot)) : '',
    );
    this.inspector.energy.push(snapshot.diagnostics.simTime, snapshot.diagnostics.kinetic, snapshot.diagnostics.potential, snapshot.diagnostics.total);
    this.drift = this.inspector.energy.drift;
    this.hud.update(snapshot.diagnostics, this.warp, this.drift);
    this.inFlight = false;
    this.lastSnapshotAt = snapshot.simTime;

    // Hand the buffers straight back so the worker never has to allocate.
    this.recycleQueue.push(snapshot);
    if (this.recycleQueue.length > 2) {
      const old = this.recycleQueue.shift()!;
      this.post(
        {
          type: 'recycle',
          pos: old.pos,
          vel: old.vel,
          radii: old.radii,
          temp: old.temp,
          flags: old.flags,
          tint: old.tint,
          atmos: old.atmos,
          ids: old.ids,
          particles: old.particles,
        },
        [
          old.pos.buffer as ArrayBuffer,
          old.vel.buffer as ArrayBuffer,
          old.radii.buffer as ArrayBuffer,
          old.temp.buffer as ArrayBuffer,
          old.flags.buffer as ArrayBuffer,
          old.tint.buffer as ArrayBuffer,
          old.atmos.buffer as ArrayBuffer,
          old.ids.buffer as ArrayBuffer,
        ],
      );
    }

    if (this.pendingFollow >= 0) {
      const found = this.scene.lookup(this.pendingFollow);
      if (found) {
        this.rig.followEnabled = true;
        this.rig.focusOn(this.pendingFollow, found.position, found.radius, 6);
        this.pendingFollow = -1;
      }
    }

    const loading = document.getElementById('loading');
    if (loading && !loading.classList.contains('done')) loading.classList.add('done');
  }

  private primaryIdFor(snapshot: Snapshot): number {
    if (!snapshot.selected) return -1;
    // The worker does not ship the primary id, so show the most massive body
    // that is not the selection itself.
    return snapshot.selected.id;
  }

  selectedId = -1;

  // ── Camera interaction ────────────────────────────────────────────────────

  private bindInteraction(): void {
    let downX = 0;
    let downY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
      this.canvas.classList.add('dragging');
    });
    this.canvas.addEventListener('pointerup', (e) => {
      this.canvas.classList.remove('dragging');
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
      const rect = this.canvas.getBoundingClientRect();
      const id = this.scene.pick(e.clientX - rect.left, e.clientY - rect.top, this.rig, rect.width, rect.height);
      this.selectedId = id;
      this.scene.selectedId = id;
      this.post({ type: 'select', id });
      if (id >= 0) {
        this.post({ type: 'focus', id });
        const found = this.scene.lookup(id);
        if (found) {
          this.rig.followEnabled = true;
          this.rig.focusOn(id, found.position, found.radius, 6);
        }
      } else {
        this.inspector.setEmpty('click a body to inspect it');
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const id = this.scene.pick(e.clientX - rect.left, e.clientY - rect.top, this.rig, rect.width, rect.height);
      this.scene.setHover(id);
      this.canvas.style.cursor = id >= 0 ? 'pointer' : 'grab';
    });
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.actions.setPaused(!this.paused);
          this.timebar.syncPlayIcon();
          break;
        case 'KeyH':
          document.getElementById('help')?.classList.toggle('visible');
          break;
        case 'KeyR':
          this.actions.scenario('reset');
          break;
        case 'KeyG':
          this.setOverlay('grid', !this.scene.options.showGrid);
          break;
        case 'KeyL':
          this.setOverlay('labels', !this.scene.options.showLabels);
          break;
        case 'KeyB':
          this.setPipeline('bloom', !this.pipeline.toggles.bloom);
          break;
        case 'Equal':
        case 'NumpadAdd': {
          const next = WARP_LADDER.find((w) => w > this.warp * 1.001);
          if (next) this.actions.setWarp(next);
          break;
        }
        case 'Minus':
        case 'NumpadSubtract': {
          const lower = WARP_LADDER.filter((w) => w < this.warp * 0.999);
          if (lower.length) this.actions.setWarp(lower[lower.length - 1]);
          break;
        }
      }
    });
  }

  private buildHelp(): void {
    const help = document.createElement('div');
    help.id = 'help';
    help.innerHTML = `
      <div class="card">
        <h1>Cosmoscope <span>· gravity, decoded</span></h1>
        <p style="color:var(--dim);margin:0 0 4px">A real-time N-body laboratory. Every number on screen is computed from the same equations a textbook uses — RK4 on the full pairwise force law, with 1PN relativity, tidal dissipation, radiative balance and Roche-limit breakup available on demand.</p>
        <div class="cols">
          <div>
            <h3>Camera</h3>
            <div><kbd>drag</kbd> orbit</div>
            <div><kbd>right-drag</kbd> pan</div>
            <div><kbd>wheel</kbd> zoom</div>
            <div><kbd>click</kbd> select &amp; follow</div>
          </div>
          <div>
            <h3>Time</h3>
            <div><kbd>space</kbd> pause</div>
            <div><kbd>+ / −</kbd> time warp</div>
            <div><kbd>⇄</kbd> run time backwards</div>
            <div><kbd>R</kbd> restart the lab</div>
          </div>
          <div>
            <h3>Overlays</h3>
            <div><kbd>G</kbd> spacetime grid</div>
            <div><kbd>L</kbd> labels</div>
            <div><kbd>B</kbd> bloom</div>
            <div><kbd>H</kbd> this help</div>
          </div>
          <div>
            <h3>Reading the HUD</h3>
            <div>• sub-steps rise at periapsis — that is ∇g at work</div>
            <div>• |ΔE/E| near 10⁻¹⁰ means the integrator is trustworthy</div>
            <div>• watch the Roche / Hill radii in the inspector</div>
          </div>
        </div>
      </div>`;
    help.addEventListener('click', () => help.classList.remove('visible'));
    this.root.appendChild(help);
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.pipeline.setSize(width, height);
    this.rig.setAspect(width / Math.max(height, 1));
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  private frame(): void {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const realDt = clamp((now - this.lastFrame) / 1000, 0, 0.25);
    this.lastFrame = now;
    this.hud.setFps(realDt);
    this.hud.tick(now);

    // Physics: one advance in flight at a time, so the worker is never buried.
    if (!this.paused && !this.inFlight) {
      const simDt = realDt * this.warp * (this.reversed ? -1 : 1);
      this.pendingDt = simDt;
      this.inFlight = true;
      this.post({ type: 'advance', dt: simDt, maxSteps: 48 });
    } else if (this.paused && !this.inFlight && this.pendingDt !== 0) {
      this.pendingDt = 0;
    }

    const rect = this.canvas.getBoundingClientRect();
    this.rig.update(realDt, (id) => {
      const found = this.scene.lookup(id);
      return found ? { position: found.position, radius: found.radius } : null;
    });
    this.scene.updateFrame(this.rig, this.pipeline, rect.width, rect.height);
    this.pipeline.renderScene(this.scene.scene, this.rig.camera, realDt);
    this.pipeline.composite();

    // The energy plot is 2D canvas work; 12 Hz is plenty for a telemetry trace.
    this.graphTimer += realDt;
    if (this.graphTimer > 1 / 12) {
      this.graphTimer = 0;
      this.inspector.energy.draw();
    }
  }
}
