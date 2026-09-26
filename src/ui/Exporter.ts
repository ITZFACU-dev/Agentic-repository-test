/**
 * Data export.
 *
 * The point of a lab is to leave with numbers, so Cosmoscope can hand over
 *
 *   • a **CSV time series** — one row per animation frame: simulated time,
 *     kinetic / potential / total energy, the drift of the total, and the
 *     selected body's orbital elements and temperature. This is what goes
 *     straight into a spreadsheet or a Python notebook to plot E(t), a(t) or
 *     the Lyapunov divergence.
 *   • a **full state dump** — JSON, SI units, every body and every derived
 *     quantity the engine knows, with the parameters that produced it.
 *
 * Both are generated in the browser; nothing is uploaded anywhere.
 */

import { el, fmt } from './dom';
import type { Snapshot } from '../sim/protocol';

export interface Sample {
  wallMs: number;
  simSeconds: number;
  kinetic: number;
  potential: number;
  total: number;
  drift: number;
  bodies: number;
  substeps: number;
  /** Selected body, when there is one. */
  bodyName: string;
  a: number;
  e: number;
  inclination: number;
  argPeriapsis: number;
  period: number;
  speed: number;
  surfaceTemp: number;
  accretionLuminosity: number;
}

const MAX_SAMPLES = 40000;

export class Exporter {
  private samples: Sample[] = [];
  private reference: number | null = null;
  private startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  private lastSampleAt = -1;

  /** Called on every snapshot: one row of the time series. */
  sample(snapshot: Snapshot): void {
    // Ignore duplicate snapshots (the same simulation time twice).
    if (snapshot.simTime === this.lastSampleAt) return;
    this.lastSampleAt = snapshot.simTime;
    const d = snapshot.diagnostics;
    if (this.reference === null) this.reference = d.total;
    const drift = Math.abs(this.reference) > 0 ? (d.total - this.reference) / Math.abs(this.reference) : 0;
    const telemetry = snapshot.selected;
    this.samples.push({
      wallMs: typeof performance !== 'undefined' ? performance.now() - this.startedAt : 0,
      simSeconds: d.simTime,
      kinetic: d.kinetic,
      potential: d.potential,
      total: d.total,
      drift,
      bodies: d.bodies,
      substeps: d.substeps,
      bodyName: telemetry?.name ?? '',
      a: telemetry?.elements?.a ?? NaN,
      e: telemetry?.elements?.e ?? NaN,
      inclination: telemetry?.elements?.i ?? NaN,
      argPeriapsis: telemetry?.elements?.argPeriapsis ?? NaN,
      period: telemetry?.elements?.period ?? NaN,
      speed: telemetry?.elements?.speed ?? NaN,
      surfaceTemp: telemetry?.surfaceTemp ?? NaN,
      accretionLuminosity: telemetry?.accretion ?? 0,
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  reset(): void {
    this.samples = [];
    this.reference = null;
    this.startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    this.lastSampleAt = -1;
  }

  get count(): number {
    return this.samples.length;
  }

  /** Build the CSV. Every numeric column is SI unless the unit is in its name. */
  toCsv(presetId: string): string {
    const header = [
      'wall_ms',
      'sim_seconds',
      'sim_years',
      'kinetic_energy_J',
      'potential_energy_J',
      'total_energy_J',
      'relative_drift',
      'bodies',
      'substeps',
      'selected_body',
      'semi_major_axis_m',
      'eccentricity',
      'inclination_rad',
      'arg_periapsis_rad',
      'period_s',
      'speed_m_s',
      'surface_temp_K',
      'accretion_luminosity_W',
    ];
    const lines: string[] = [
      `# Cosmoscope data export — preset ${presetId}`,
      `# generated ${new Date().toISOString()}`,
      `# ${this.samples.length} samples; all quantities SI`,
      header.join(','),
    ];
    for (const s of this.samples) {
      lines.push(
        [
          s.wallMs.toFixed(1),
          s.simSeconds.toPrecision(10),
          (s.simSeconds / 3.15576e7).toPrecision(8),
          s.kinetic.toExponential(10),
          s.potential.toExponential(10),
          s.total.toExponential(10),
          s.drift.toExponential(6),
          s.bodies,
          s.substeps,
          s.bodyName,
          Number.isFinite(s.a) ? s.a.toPrecision(10) : '',
          Number.isFinite(s.e) ? s.e.toPrecision(8) : '',
          Number.isFinite(s.inclination) ? s.inclination.toPrecision(8) : '',
          Number.isFinite(s.argPeriapsis) ? s.argPeriapsis.toPrecision(8) : '',
          Number.isFinite(s.period) ? s.period.toPrecision(10) : '',
          Number.isFinite(s.speed) ? s.speed.toPrecision(10) : '',
          Number.isFinite(s.surfaceTemp) ? s.surfaceTemp.toPrecision(8) : '',
          s.accretionLuminosity.toExponential(6),
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  /** A short human-readable summary — handy for pasting into a lab notebook. */
  toSummary(presetId: string, warp: number): string {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 'No samples collected yet.';
    const lines = [
      `Cosmoscope run summary — ${presetId}`,
      `wall clock        ${((last.wallMs - first.wallMs) / 1000).toFixed(1)} s`,
      `simulated time    ${fmt.time(last.simSeconds - first.simSeconds)} (warp: 1 s = ${fmt.time(warp)})`,
      `bodies            ${last.bodies}`,
      `samples           ${this.samples.length}`,
      `energy drift      ${(last.drift * 100).toExponential(3)} %`,
      `mean sub-steps    ${(this.samples.reduce((acc, s) => acc + s.substeps, 0) / this.samples.length).toFixed(2)}`,
    ];
    if (last.bodyName) {
      lines.push(
        `selected body     ${last.bodyName}`,
        `  a = ${fmt.metres(last.a)}, e = ${Number.isFinite(last.e) ? last.e.toFixed(6) : '—'}, i = ${fmt.angle(last.inclination)}`,
        `  |v| = ${fmt.speed(last.speed)}, T_surf = ${fmt.temp(last.surfaceTemp)}`,
      );
    }
    return lines.join('\n');
  }
}

/** Trigger a client-side download of a text payload. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

/** A small row of export buttons, dropped into the inspector. */
export function exportRow(
  parent: HTMLElement,
  handlers: { csv: () => void; state: () => void; summary: () => void },
): HTMLElement {
  const row = el('div', 'row');
  row.style.gap = '6px';
  const make = (label: string, title: string, fn: () => void) => {
    const b = el('button', undefined, label);
    b.title = title;
    b.style.flex = '1';
    b.style.fontSize = '11px';
    b.style.padding = '5px 4px';
    b.addEventListener('click', fn);
    row.appendChild(b);
    return b;
  };
  make('CSV', 'Download the time series (energy, orbital elements, temperature)', handlers.csv);
  make('JSON', 'Download the complete state: every body, SI units', handlers.state);
  make('Summary', 'Copy a short text summary of this run', handlers.summary);
  parent.appendChild(row);
  return row;
}
