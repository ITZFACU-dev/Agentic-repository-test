/**
 * Left-hand control panel and the bottom time bar.
 *
 * Everything here maps to a real engine parameter — no cosmetic switches. The
 * what-if sliders (G, c, radiation pressure, solar luminosity) literally change
 * the force law the integrator is solving, which is what makes "what would
 * happen if gravity were stronger?" a measurable experiment rather than a
 * thought experiment.
 */

import { button, el, fmt, panel, section, segmented, slider, toggle, WARP_LADDER, warpLabel } from './dom';
import type { PhysicsParams } from '../physics/PhysicsEngine';
import type { ScenarioName } from '../sim/protocol';
import { PRESETS, PRESET_CATEGORIES } from '../sim/presets';

export interface UiActions {
  loadPreset(id: string): void;

  setParams(params: Partial<PhysicsParams>): void;

  whatIf(key: 'G' | 'c' | 'radiationPressure' | 'solarLuminosity', value: number): void;

  scenario(name: ScenarioName): void;

  overlay(option: OverlayName, value: boolean | number | string): void;

  pipeline(option: PipelineName, value: boolean | number): void;

  setWarp(warp: number): void;

  setPaused(paused: boolean): void;

  stepOnce(): void;

  toggleReverse(): void;

  paused: boolean;
}

export type OverlayName =
  | 'labels'
  | 'trails'
  | 'grid'
  | 'habitability'
  | 'vectors'
  | 'lagrange'
  | 'exaggeration'
  | 'atmosphereQuality'
  | 'atmosphereDensity'
  | 'atmosphereBetaR'
  | 'atmosphereBetaM';

export type PipelineName = 'bloom' | 'eyeAdaptation' | 'lensing' | 'bloomStrength' | 'exposureBias' | 'chromatic';

export class LeftPanel {
  readonly root: HTMLDivElement;
  private tabsBody: HTMLDivElement;
  private currentTab = 'scenarios';
  private presetButtons = new Map<string, HTMLButtonElement>();
  private lessonBox: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly actions: UiActions) {
    this.root = panel('left', parent);
    this.root.id = 'left';
    const tabs = el('div', 'tabs');
    const tabsBody = el('div', 'tab-body scroll');
    this.tabsBody = tabsBody;
    const definitions: [string, string][] = [
      ['scenarios', 'Labs'],
      ['physics', 'Physics'],
      ['visuals', 'Visuals'],
      ['whatif', 'What-if'],
    ];
    for (const [id, label] of definitions) {
      const tab = el('div', 'tab', label);
      tab.dataset.tab = id;
      tab.addEventListener('click', () => this.showTab(id));
      tabs.appendChild(tab);
    }
    this.lessonBox = el('div', 'lesson');
    this.lessonBox.style.display = 'none';
    this.root.appendChild(tabs);
    this.root.appendChild(tabsBody);
    this.showTab('scenarios');
  }

  showTab(id: string): void {
    this.currentTab = id;
    for (const node of Array.from(this.root.querySelectorAll('.tab'))) {
      node.classList.toggle('active', (node as HTMLElement).dataset.tab === id);
    }
    this.tabsBody.innerHTML = '';
    if (id === 'scenarios') this.buildScenarios();
    else if (id === 'physics') this.buildPhysics();
    else if (id === 'visuals') this.buildVisuals();
    else this.buildWhatIf();
  }

  private buildScenarios(): void {
    const body = this.tabsBody;
    body.appendChild(this.lessonBox);
    for (const category of PRESET_CATEGORIES) {
      const presets = PRESETS.filter((p) => p.category === category.id);
      if (presets.length === 0) continue;
      const label = el('div', 'group-label', category.label);
      label.title = category.blurb;
      body.appendChild(label);
      for (const preset of presets) {
        const b = el('button', 'wide');
        const title = el('div', undefined, preset.name);
        const small = el('small', undefined, preset.blurb);
        b.appendChild(title);
        b.appendChild(small);
        b.addEventListener('click', () => this.actions.loadPreset(preset.id));
        this.presetButtons.set(preset.id, b);
        body.appendChild(b);
      }
    }
  }

  markPreset(id: string): void {
    for (const [key, node] of this.presetButtons) node.classList.toggle('primary', key === id);
  }

  showLesson(name: string, lesson: string, watchFor: string[]): void {
    this.lessonBox.innerHTML = '';
    const h = el('div');
    h.innerHTML = `<b>${name}</b>`;
    this.lessonBox.appendChild(h);
    const p = el('div', undefined, lesson);
    this.lessonBox.appendChild(p);
    if (watchFor.length > 0) {
      const ul = el('ul');
      for (const w of watchFor) ul.appendChild(el('li', undefined, w));
      this.lessonBox.appendChild(ul);
    }
    this.lessonBox.style.display = 'block';
    if (this.currentTab === 'scenarios') this.tabsBody.prepend(this.lessonBox);
  }

  private buildPhysics(): void {
    const body = this.tabsBody;
    const integrators = section(body, 'Integrator');
    segmented(integrators, '', [
      { id: 'rk4' as const, label: 'RK4', title: 'Classical 4th-order Runge-Kutta — the default' },
      { id: 'verlet' as const, label: 'Verlet', title: 'Symplectic: bounded energy, ideal for long runs' },
      { id: 'hermite' as const, label: 'Hermite 4', title: '4th-order predictor-corrector, very accurate at periapsis' },
    ], 'rk4', (v) => this.actions.setParams({ integrator: v }));
    (integrators.querySelector('.seg') as HTMLElement).dataset.field = 'integrator';
    const note = el(
      'div',
      'preset',
      'RK4 is accurate but slowly leaks energy; velocity-Verlet conserves a shadow Hamiltonian exactly, so its energy error only oscillates; Hermite 4th-order uses the jerk da/dt.',
    );
    note.style.cursor = 'default';
    integrators.appendChild(note);

    const stepping = section(body, 'Adaptive sub-stepping');
    toggle(stepping, 'Refine near periapsis (∇g)', true, (v) => this.actions.setParams({ adaptiveSubsteps: v }));
    slider(stepping, {
      label: 'sub-step ceiling',
      min: 1,
      max: 64,
      step: 1,
      value: 8,
      onInput: (v) => this.actions.setParams({ maxSubsteps: v }),
    });
    slider(stepping, {
      label: 'softening ε',
      min: 0,
      max: 6,
      step: 1,
      value: 3,
      format: (v) => `10^${v} m`,
      onInput: (v) => this.actions.setParams({ softening: v === 0 ? 0 : Math.pow(10, v) }),
    });

    const collisions = section(body, 'Collisions & tides');
    segmented(collisions, 'collision response', [
      { id: 'merge' as const, label: 'Merge' },
      { id: 'bounce' as const, label: 'Bounce' },
      { id: 'none' as const, label: 'Ghost' },
    ], 'merge', (v) => this.actions.setParams({ collisionMode: v }));
    slider(collisions, {
      label: 'restitution (bounce)',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.35,
      format: (v) => v.toFixed(2),
      onInput: (v) => this.actions.setParams({ restitution: v }),
    });
    toggle(collisions, 'eject power-law fragments', true, (v) => this.actions.setParams({ fragmentation: v }));
    toggle(collisions, 'Roche-limit disruption', true, (v) => this.actions.setParams({ rocheLimitEnabled: v }));
    toggle(collisions, 'rigid-body Roche limit (1.26 R)', false, (v) => this.actions.setParams({ rocheRigid: v }));
    toggle(collisions, 'tidal heating & locking', true, (v) => this.actions.setParams({ tidalPhysics: v }));

    const relativity = section(body, 'Relativity');
    toggle(relativity, '1PN corrections (precession)', false, (v) => this.actions.setParams({ relativity: v }));
    toggle(relativity, 'Lense-Thirring frame dragging', false, (v) => this.actions.setParams({ frameDragging: v }));
    const relativityNote = el(
      'div',
      'preset',
      'Switch 1PN on in the Solar System lab and select Mercury: its perihelion advances by an extra 43″ per century on top of the Newtonian 532″ — the measurement that made general relativity famous. The engine adds a_rel = (GM/c²r²)[(4GM/r − v²)r̂ + 4(r̂·v)v] pairwise, and distributes the reaction by mass ratio so momentum is still conserved.',
    );
    relativityNote.style.cursor = 'default';
    relativity.appendChild(relativityNote);

    const thermo = section(body, 'Stellar & thermal');
    toggle(thermo, 'thermodynamics (albedo / greenhouse)', true, (v) => this.actions.setParams({ thermodynamics: v }));
    toggle(thermo, 'stellar evolution', true, (v) => this.actions.setParams({ stellarEvolution: v }));
    segmented(thermo, 'dark-matter halo', [
      { id: 'none' as const, label: 'None' },
      { id: 'nfw' as const, label: 'NFW' },
      { id: 'isothermal' as const, label: 'Isothermal' },
    ], 'none', (v) => this.actions.setParams({ halo: v }));
    slider(thermo, {
      label: 'halo mass (10¹² M☉)',
      min: 0.1,
      max: 5,
      step: 0.05,
      value: 1.5,
      format: (v) => v.toFixed(2),
      onInput: (v) => this.actions.setParams({ haloMass: v * 1e12 * 1.98847e30 }),
    });

    const env = section(body, 'Interstellar medium');
    slider(env, {
      label: 'drag coefficient (1/yr)',
      min: 0,
      max: 4,
      step: 0.2,
      value: 0,
      format: (v) => (v === 0 ? 'none' : `${(Math.pow(10, v) / 3.15576e7).toExponential(1)} s⁻¹`),
      onInput: (v) => this.actions.setParams({ drag: v === 0 ? 0 : Math.pow(10, v) / 3.15576e7 }),
    });
  }

  private buildVisuals(): void {
    const body = this.tabsBody;
    const overlays = section(body, 'Overlays');
    toggle(overlays, 'body labels', true, (v) => this.actions.overlay('labels', v));
    toggle(overlays, 'orbit trails', true, (v) => this.actions.overlay('trails', v));
    toggle(overlays, 'velocity / force / acceleration vectors', true, (v) => this.actions.overlay('vectors', v));
    toggle(overlays, 'spacetime curvature grid', false, (v) => this.actions.overlay('grid', v));
    toggle(overlays, 'habitable-zone ribbons', false, (v) => this.actions.overlay('habitability', v));
    toggle(overlays, 'L1–L5 Lagrange markers', false, (v) => this.actions.overlay('lagrange', v));
    slider(overlays, {
      label: 'body size exaggeration',
      min: 1,
      max: 400,
      step: 1,
      value: 1,
      format: (v) => `${v}×`,
      onInput: (v) => this.actions.overlay('exaggeration', v),
    });

    const rp = section(body, 'Render pipeline');
    toggle(rp, 'HDR bloom', true, (v) => this.actions.pipeline('bloom', v));
    toggle(rp, 'eye adaptation (auto exposure)', true, (v) => this.actions.pipeline('eyeAdaptation', v));
    toggle(rp, 'gravitational lensing', true, (v) => this.actions.pipeline('lensing', v));
    slider(rp, {
      label: 'bloom strength',
      min: 0,
      max: 2,
      step: 0.02,
      value: 0.55,
      format: (v) => v.toFixed(2),
      onInput: (v) => this.actions.pipeline('bloomStrength', v),
    });
    slider(rp, {
      label: 'exposure bias',
      min: 0.2,
      max: 4,
      step: 0.05,
      value: 1.15,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => this.actions.pipeline('exposureBias', v),
    });
    slider(rp, {
      label: 'lens dispersion',
      min: 0,
      max: 3,
      step: 0.05,
      value: 0.5,
      format: (v) => v.toFixed(2),
      onInput: (v) => this.actions.pipeline('chromatic', v),
    });

    const quality = section(body, 'Atmosphere');
    segmented(quality, 'scattering samples', [
      { id: 'low' as const, label: '6×3' },
      { id: 'medium' as const, label: '10×5' },
      { id: 'high' as const, label: '14×7' },
    ], 'high', (v) => this.actions.overlay('atmosphereQuality', v));
    slider(quality, {
      label: 'optical depth (thickness)',
      min: 0,
      max: 4,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => this.actions.overlay('atmosphereDensity', v),
    });
    slider(quality, {
      label: 'Rayleigh β_r (blue sky)',
      min: 0,
      max: 4,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => this.actions.overlay('atmosphereBetaR', v),
    });
    slider(quality, {
      label: 'Mie β_m (haze / aureole)',
      min: 0,
      max: 4,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => this.actions.overlay('atmosphereBetaM', v),
    });
  }

  private buildWhatIf(): void {
    const body = this.tabsBody;
    const intro = el('div', 'preset', 'Change the constants of nature and watch what breaks. Each slider re-solves the same equations with a different constant.');
    intro.style.cursor = 'default';
    body.appendChild(intro);

    const constants = section(body, 'Constants');
    slider(constants, {
      label: 'gravitational constant G',
      min: 0,
      max: 3,
      step: 0.01,
      value: 1,
      format: (v) => `${v.toFixed(2)} × G`,
      onInput: (v) => this.actions.whatIf('G', v),
    });
    slider(constants, {
      label: 'speed of light c',
      min: 0.05,
      max: 3,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)} × c`,
      onInput: (v) => this.actions.whatIf('c', v),
    });
    slider(constants, {
      label: 'radiation pressure',
      min: 0,
      max: 40,
      step: 0.5,
      value: 0,
      format: (v) => (v === 0 ? 'off' : `${v.toFixed(1)} × sunlight`),
      onInput: (v) => this.actions.whatIf('radiationPressure', v),
    });
    slider(constants, {
      label: 'solar luminosity',
      min: 0,
      max: 3,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)} L☉`,
      onInput: (v) => this.actions.whatIf('solarLuminosity', v),
    });

    const scenarios = section(body, 'One-click thought experiments');
    const put = (label: string, name: ScenarioName) => button(scenarios, label, () => this.actions.scenario(name), 'wide');
    put('Replace the Sun with a black hole of the same mass', 'sun-to-blackhole');
    put('Add a Jupiter-mass object to Earth’s orbit', 'jupiter-to-earth-orbit');
    put('Collide the Moon with Earth', 'moon-into-earth');
    put('Launch a probe at 1.02 × escape velocity', 'launch-probe');
    put('Freeze all moons in place', 'freeze-moons');
    put('Reset the lab', 'reset');
  }
}

export class TimeBar {
  readonly root: HTMLDivElement;
  private warpSlider: HTMLInputElement;
  private nowEl: HTMLDivElement;
  private playButton: HTMLButtonElement;
  private reverseOn = false;

  constructor(parent: HTMLElement, private readonly actions: UiActions) {
    this.root = panel('', parent);
    this.root.id = 'timebar';
    const transport = el('div', 'transport');
    this.playButton = el('button', 'primary', '❚❚');
    this.playButton.title = 'Pause / resume (space)';
    this.playButton.addEventListener('click', () => {
      this.actions.setPaused(!this.actions.paused);
      this.syncPlayIcon();
    });
    const stepButton = el('button', undefined, '⏭');
    stepButton.title = 'Single integration step';
    stepButton.addEventListener('click', () => this.actions.stepOnce());
    const reverse = el('button', undefined, '⇄');
    reverse.title = 'Reverse time (negative dt)';
    reverse.addEventListener('click', () => {
      this.reverseOn = !this.reverseOn;
      reverse.classList.toggle('active', this.reverseOn);
      this.actions.toggleReverse();
    });
    const reset = el('button', undefined, '⟲');
    reset.title = 'Restart the current lab';
    reset.addEventListener('click', () => this.actions.scenario('reset'));
    transport.append(this.playButton, stepButton, reverse, reset);

    const warp = el('div', 'warp');
    const labels = el('div', 'labels');
    labels.appendChild(el('span', undefined, '1 s = 1 s'));
    labels.appendChild(el('span', undefined, '1 s = 1 Myr'));
    this.warpSlider = el('input');
    this.warpSlider.type = 'range';
    this.warpSlider.min = '0';
    this.warpSlider.max = String(WARP_LADDER.length - 1);
    this.warpSlider.step = '1';
    this.warpSlider.value = '0';
    this.warpSlider.addEventListener('input', () => {
      const index = Number(this.warpSlider.value);
      this.actions.setWarp(WARP_LADDER[index]);
      this.updateWarpLabel(WARP_LADDER[index]);
    });
    this.nowEl = el('div', 'now', warpLabel(1));
    warp.append(labels, this.warpSlider, this.nowEl);
    this.root.append(transport, warp);
    parent.appendChild(this.root);
  }

  setWarp(warp: number): void {
    const index = WARP_LADDER.findIndex((w) => w >= warp);
    this.warpSlider.value = String(index < 0 ? WARP_LADDER.length - 1 : index);
    this.updateWarpLabel(warp);
  }

  private updateWarpLabel(warp: number): void {
    this.nowEl.textContent = warpLabel(warp);
  }

  syncPlayIcon(): void {
    this.playButton.textContent = this.actions.paused ? '▶' : '❚❚';
  }

  get reversed(): boolean {
    return this.reverseOn;
  }
}

export function formatMass(m: number): string {
  return fmt.mass(m);
}
