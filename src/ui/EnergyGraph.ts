/**
 * Live energy-conservation graph.
 *
 * E_k + E_p = E_total is the single most important sanity check in any N-body
 * simulation: if the total drifts, the integrator is losing the plot. Plotting
 * the *relative* drift rather than the raw energy keeps the curve readable
 * whether the system is a figure-eight (10⁻¹⁶) or a galaxy (10⁻⁹).
 */

import { el, fmt } from './dom';

interface Sample {
  t: number;
  kinetic: number;
  potential: number;
  total: number;
}

export class EnergyGraph {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private samples: Sample[] = [];
  private capacity = 900;
  private reference: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div');
    this.canvas = el('canvas');
    this.canvas.id = 'energy';
    this.canvas.width = 620;
    this.canvas.height = 192;
    this.ctx = this.canvas.getContext('2d');
    const legend = el('div', 'legend');
    legend.innerHTML =
      '<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#6fe08a;margin-right:4px"></i>kinetic</span>' +
      '<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#ff6a5c;margin-right:4px"></i>potential</span>' +
      '<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#5cc8ff;margin-right:4px"></i>total</span>';
    this.root.appendChild(this.canvas);
    this.root.appendChild(legend);
    parent.appendChild(this.root);
  }

  reset(): void {
    this.samples = [];
    this.reference = null;
  }

  push(t: number, kinetic: number, potential: number, total: number): void {
    this.samples.push({ t, kinetic, potential, total });
    if (this.samples.length > this.capacity) this.samples.shift();
    if (this.reference === null || Math.abs(this.reference) < 1e-30) this.reference = total;
  }

  get drift(): number {
    if (this.reference === null || this.samples.length === 0) return 0;
    const last = this.samples[this.samples.length - 1];
    return Math.abs(this.reference) > 0 ? (last.total - this.reference) / Math.abs(this.reference) : 0;
  }

  draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (this.samples.length < 2) {
      ctx.fillStyle = 'rgba(139,154,181,0.7)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('collecting energy samples…', 10, h / 2);
      return;
    }

    // Plot the three series on a shared scale in log space, so a 10²³ J
    // kinetic term and a 10²⁴ J potential term fit in the same box.
    const magnitudes = this.samples.map((s) => Math.max(Math.abs(s.kinetic), Math.abs(s.potential), Math.abs(s.total)));
    const maxLog = Math.log10(Math.max(...magnitudes, 1));
    const minLog = Math.log10(Math.max(Math.min(...magnitudes.filter((m) => m > 0)), 1)) - 0.5;
    const scale = (v: number) => {
      const l = Math.log10(Math.max(Math.abs(v), 1e-12));
      const t = (l - minLog) / Math.max(maxLog - minLog, 1e-6);
      return h - 8 - t * (h - 20);
    };

    ctx.strokeStyle = 'rgba(120,160,220,0.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 8 + (i * (h - 20)) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const series: [keyof Sample, string][] = [
      ['kinetic', '#6fe08a'],
      ['potential', '#ff6a5c'],
      ['total', '#5cc8ff'],
    ];
    for (const [key, color] of series) {
      ctx.strokeStyle = color;
      ctx.lineWidth = key === 'total' ? 2 : 1.3;
      ctx.beginPath();
      this.samples.forEach((s, i) => {
        const x = (i / (this.samples.length - 1)) * w;
        const y = scale(Math.abs(s[key]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Drift readout.
    const drift = this.drift;
    ctx.fillStyle = Math.abs(drift) < 1e-6 ? '#6fe08a' : Math.abs(drift) < 1e-3 ? '#ffb45c' : '#ff6a5c';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`|ΔE/E| = ${drift.toExponential(2)}`, 8, 14);
    const last = this.samples[this.samples.length - 1];
    ctx.fillStyle = 'rgba(223,231,245,0.75)';
    ctx.fillText(`E = ${fmt.energy(last.total)}`, 8, h - 8);
  }
}
