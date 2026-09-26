/** Small math helpers shared by the physics core and the renderer. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic 32-bit PRNG (mulberry32) — keeps presets reproducible. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian sample (Box-Muller) from a uniform generator. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 3-vector helpers on plain number tuples. */
export type Vec3 = [number, number, number];

export const v3 = {
  add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
  },
  dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  },
  len(a: Vec3): number {
    return Math.hypot(a[0], a[1], a[2]);
  },
  norm(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** Newton-Raphson deflection of a body's velocity for a gravity assist / burn. */
export function maxAbs(arr: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < arr.length; i++) {
    const a = Math.abs(arr[i]);
    if (a > m) m = a;
  }
  return m;
}

/** Rolling statistics used by the energy-conservation telemetry. */
export class RollingStats {
  private buf: Float64Array;
  private i = 0;
  private filled = 0;
  constructor(size = 240) {
    this.buf = new Float64Array(size);
  }
  push(v: number) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }
  get mean(): number {
    if (!this.filled) return 0;
    let s = 0;
    for (let k = 0; k < this.filled; k++) s += this.buf[k];
    return s / this.filled;
  }
  get max(): number {
    let m = -Infinity;
    for (let k = 0; k < this.filled; k++) if (this.buf[k] > m) m = this.buf[k];
    return this.filled ? m : 0;
  }
  get min(): number {
    let m = Infinity;
    for (let k = 0; k < this.filled; k++) if (this.buf[k] < m) m = this.buf[k];
    return this.filled ? m : 0;
  }
  get std(): number {
    const m = this.mean;
    let s = 0;
    for (let k = 0; k < this.filled; k++) s += (this.buf[k] - m) ** 2;
    return this.filled ? Math.sqrt(s / this.filled) : 0;
  }
  get last(): number {
    return this.filled ? this.buf[(this.i - 1 + this.buf.length) % this.buf.length] : 0;
  }
  get count() {
    return this.filled;
  }
  clear() {
    this.i = 0;
    this.filled = 0;
    this.buf.fill(0);
  }
}
