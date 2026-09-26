/**
 * Top-bar telemetry and the physics event ticker.
 *
 * The top bar is the "instrument cluster": it shows exactly what the engine is
 * doing every frame — integrator, sub-step count, wall-clock cost per step,
 * body count and the drift of the conserved quantities — so the physics is
 * auditable while you watch it.
 */

import { el, fmt, warpLabel } from './dom';
import type { Diagnostics } from '../sim/protocol';

interface Readout {
  value: HTMLElement;
  row: HTMLElement;
}

export class HUD {
  readonly root: HTMLDivElement;
  private readouts: Record<string, Readout> = {};
  private ticker: HTMLDivElement;
  private warnPill: HTMLElement;
  private fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private events: { node: HTMLDivElement; born: number }[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'panel');
    this.root.id = 'topbar';
    const brand = el('div', 'brand', 'Cosmoscope');
    this.root.appendChild(brand);
    const make = (key: string, label: string, initial: string) => {
      const row = el('div', 'readout');
      const value = el('b', undefined, initial);
      row.appendChild(value);
      row.appendChild(el('span', undefined, label));
      this.root.appendChild(row);
      this.readouts[key] = { value, row };
    };
    make('time', 'simulated time', '—');
    make('warp', 'time warp', '1 s = 1 s');
    make('bodies', 'bodies', '0');
    make('integrator', 'integrator', 'RK4');
    make('substeps', 'sub-steps / step', '1');
    make('step', 'ms / step', '—');
    make('drift', 'energy drift', '—');
    make('fps', 'fps', '—');
    const warn = el('div', 'pill warn', 'warp exceeds resolution');
    warn.style.display = 'none';
    warn.title = 'The requested time warp is too large to integrate accurately; reduce it to restore full sub-stepping.';
    this.root.appendChild(warn);
    this.warnPill = warn;
    this.ticker = el('div');
    this.ticker.id = 'events';
    parent.appendChild(this.ticker);
    parent.appendChild(this.root);
  }

  setFps(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum > 0.4) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.readouts.fps.value.textContent = this.fps.toFixed(0);
    }
  }

  update(diagnostics: Diagnostics, warp: number, drift: number): void {
    this.readouts.time.value.textContent = fmt.time(diagnostics.simTime);
    this.readouts.warp.value.textContent = warpLabel(warp);
    this.readouts.bodies.value.textContent = `${diagnostics.bodies}${diagnostics.destroyed ? ` (${diagnostics.destroyed} destroyed)` : ''}`;
    this.readouts.integrator.value.textContent = diagnostics.integrator.toUpperCase();
    this.readouts.substeps.value.textContent = String(diagnostics.substeps);
    this.readouts.step.value.textContent = diagnostics.msPerStep.toFixed(1);
    const d = this.readouts.drift.value;
    d.textContent = `${(drift * 100).toExponential(2)} %`;
    d.className = Math.abs(drift) < 1e-6 ? 'good' : Math.abs(drift) < 1e-3 ? 'warn' : 'bad';
  }

  setDegraded(degraded: boolean): void {
    this.warnPill.style.display = degraded ? 'inline-block' : 'none';
  }

  /** Physics events, newest first, auto-expiring. */
  pushEvent(text: string, hot = false, now = performance.now()): void {
    const node = el('div', `event${hot ? ' hot' : ''}`, text);
    this.ticker.prepend(node);
    this.events.push({ node, born: now });
    while (this.events.length > 5) {
      const old = this.events.shift();
      old?.node.remove();
    }
  }

  tick(now: number): void {
    while (this.events.length > 0 && now - this.events[0].born > 22000) {
      const old = this.events.shift();
      old?.node.remove();
    }
  }

  clearEvents(): void {
    for (const e of this.events) e.node.remove();
    this.events = [];
  }
}
