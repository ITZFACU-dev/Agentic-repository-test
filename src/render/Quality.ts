/**
 * Quality profiles and the automatic tuner.
 *
 * A 4-octave fBm planet filling a 4K screen is a very different workload from the
 * same planet as a dot in a 1 000-body galaxy, and only the machine in front of
 * the user knows which it can afford. So the renderer ships five profiles, picks
 * one from the GPU it finds, and then keeps watching the actual frame time and
 * moves up or down on its own. The physics is never touched: only how many
 * samples the pixels get.
 */

import { clamp } from '../core/mathx';

export type QualityTier = 'potato' | 'low' | 'medium' | 'high' | 'ultra';
export type QualityChoice = 'auto' | QualityTier;

export interface QualityProfile {
  id: QualityTier;
  label: string;
  /** Cap on devicePixelRatio (the single biggest cost on HiDPI screens). */
  pixelRatio: number;
  /** Extra resolution multiplier applied on top of the pixel ratio. */
  renderScale: number;
  /** fBm octaves for procedural surfaces (1 = minimum, 7 = maximum). */
  surfaceOctaves: number;
  /** Atmosphere ray-march samples: view × light. */
  atmosView: number;
  atmosLight: number;
  /** Starfield detail: 0 = bright stars only, 2 = full catalogue + nebulae. */
  starDetail: number;
  /** Bloom mip levels (1–4). */
  bloomMips: number;
  /** Tri-tap lens dispersion in the composite (0 disables it). */
  chromatic: number;
  /** Resolution divisor for the curvature grid mesh. */
  gridSegments: number;
  /** Milky Way / nebula visibility multiplier. */
  deepSky: number;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  potato: {
    id: 'potato',
    label: 'Potato',
    pixelRatio: 0.75,
    renderScale: 0.8,
    surfaceOctaves: 2,
    atmosView: 4,
    atmosLight: 2,
    starDetail: 0,
    bloomMips: 1,
    chromatic: 0,
    gridSegments: 96,
    deepSky: 0.35,
  },
  low: {
    id: 'low',
    label: 'Low',
    pixelRatio: 1,
    renderScale: 0.85,
    surfaceOctaves: 3,
    atmosView: 6,
    atmosLight: 3,
    starDetail: 0,
    bloomMips: 2,
    chromatic: 0,
    gridSegments: 128,
    deepSky: 0.6,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    pixelRatio: 1,
    renderScale: 1,
    surfaceOctaves: 5,
    atmosView: 10,
    atmosLight: 5,
    starDetail: 1,
    bloomMips: 3,
    chromatic: 0,
    gridSegments: 160,
    deepSky: 1,
  },
  high: {
    id: 'high',
    label: 'High',
    pixelRatio: 1.5,
    renderScale: 1,
    surfaceOctaves: 6,
    atmosView: 12,
    atmosLight: 6,
    starDetail: 2,
    bloomMips: 4,
    chromatic: 0.4,
    gridSegments: 200,
    deepSky: 1,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra',
    pixelRatio: 2,
    renderScale: 1,
    surfaceOctaves: 7,
    atmosView: 14,
    atmosLight: 7,
    starDetail: 2,
    bloomMips: 4,
    chromatic: 0.6,
    gridSegments: 256,
    deepSky: 1,
  },
};

export const QUALITY_ORDER: QualityTier[] = ['potato', 'low', 'medium', 'high', 'ultra'];

/**
 * Pick a starting profile from the hardware we can see. Anything we cannot
 * identify starts at **medium**: guessing high costs 10 fps on a laptop, while
 * guessing medium costs a little polish on a workstation, and the tuner will
 * climb back up within a few seconds anyway.
 */
export function detectStartTier(renderer: {
  getContext(): WebGLRenderingContext | WebGL2RenderingContext;
}): QualityTier {
  let cores = 4;
  try {
    cores = navigator.hardwareConcurrency || 4;
  } catch {
    /* worker-less environments */
  }
  let gpu = 'unknown';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') || 'unknown';
  } catch {
    /* privacy-restricted contexts */
  }
  const name = gpu.toLowerCase();
  const software = /swiftshader|llvmpipe|software|basic render|microsoft basic/.test(name);
  if (software) return 'potato';
  const integrated = /intel|uhd graphics|hd graphics|iris|mali|adreno|powervr|videocore|apple gpu|radeon graphics|vega \d/.test(name);
  const discrete = /rtx|gtx \d|geforce|radeon rx|quadro|arc a|apple m\d/.test(name);
  if (discrete && cores >= 8) return 'ultra';
  if (discrete) return 'high';
  if (integrated) return cores >= 8 ? 'medium' : 'low';
  if (cores <= 2) return 'potato';
  if (cores <= 4) return 'low';
  return 'medium';
}

export interface QualityEvents {
  onChange(profile: QualityProfile, reason: 'manual' | 'auto'): void;
}

/**
 * Frame-time governor.
 *
 * Downgrades after ~0.7 s of slow frames (a hitch is not a trend) and upgrades
 * only after 5 s of comfortably fast ones, then waits for the next measurement
 * window before deciding again — so it settles instead of oscillating.
 */
export class QualityController {
  choice: QualityChoice = 'auto';
  private measured: QualityTier;
  private ema = 16.7;
  private samples = 0;
  private cooldown = 45;

  constructor(
    start: QualityTier,
    private readonly events: QualityEvents,
    private readonly targetMs = 20,
  ) {
    this.measured = start;
  }

  get profile(): QualityProfile {
    return QUALITY_PROFILES[this.choice === 'auto' ? this.measured : this.choice];
  }

  /** The tier the tuner has settled on, regardless of a manual override. */
  get autoTier(): QualityTier {
    return this.measured;
  }

  setChoice(choice: QualityChoice): void {
    this.choice = choice;
    this.cooldown = 60;
    this.events.onChange(this.profile, 'manual');
  }

  /** Feed one frame time in milliseconds. */
  sample(frameMs: number): void {
    this.samples++;
    // Ignore the first frames: shader compilation and texture upload dominate.
    if (this.samples < 30) return;
    this.ema += (frameMs - this.ema) * 0.08;
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }
    if (this.choice !== 'auto') return;

    const index = QUALITY_ORDER.indexOf(this.measured);
    if (this.ema > this.targetMs && index > 0) {
      this.measured = QUALITY_ORDER[index - 1];
      this.cooldown = 90;
      this.events.onChange(this.profile, 'auto');
    } else if (this.ema < this.targetMs * 0.55 && index < QUALITY_ORDER.length - 2) {
      // Only ever climb as far as "high" automatically; ultra is opt-in.
      this.measured = QUALITY_ORDER[index + 1];
      this.cooldown = 300;
      this.events.onChange(this.profile, 'auto');
    }
  }

  get frameMs(): number {
    return this.ema;
  }

  /** Text for the HUD. */
  describe(): string {
    const auto = this.choice === 'auto' ? ` (auto, ${this.ema.toFixed(1)} ms)` : '';
    return `${this.profile.label}${auto}`;
  }

  /** 0..1 detail scalar handed to the procedural shaders. */
  get detail(): number {
    return clamp(this.profile.surfaceOctaves / 7, 0.15, 1);
  }
}
