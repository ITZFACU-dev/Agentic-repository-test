/**
 * Barnes-Hut octree — the O(N log N) force kernel.
 *
 * Direct summation is exact but O(N²); it is used for N ≤ 64 (every planetary
 * preset). Above that the engine builds this octree each force evaluation with
 * a user-tunable opening angle θ; θ → 0 degenerates to exact summation, which
 * lets the fast path be validated against the exact one at runtime (the HUD
 * shows the acceleration error between the two when `verifyTree` is on).
 *
 * "Tracer" bodies (galaxy test-particles, debris, dark-matter markers) are
 * excluded from the tree and therefore cost only the traversal, not the build.
 */

const MAX_DEPTH = 24;

export class BarnesHut {
  private cap: number;
  private nCenter: Float64Array;
  private nHalf: Float64Array;
  private nMass: Float64Array;
  private nCom: Float64Array;
  private nChild: Int32Array;
  private nChildCount: Uint8Array;
  private nBody: Int32Array;
  private nodeCount = 0;
  private stack = new Int32Array(1024);

  /** Global softening added to every cell interaction (m²). */
  eps2 = 0;
  G = 6.6743e-11;
  /** Opening angle: smaller = more accurate & slower. */
  theta = 0.5;
  /** Number of body–cell interactions in the last build+traverse. */
  pairCount = 0;

  constructor(capacity = 8192) {
    this.cap = capacity;
    this.nCenter = new Float64Array(capacity * 3);
    this.nHalf = new Float64Array(capacity);
    this.nMass = new Float64Array(capacity);
    this.nCom = new Float64Array(capacity * 3);
    this.nChild = new Int32Array(capacity * 8).fill(-1);
    this.nChildCount = new Uint8Array(capacity);
    this.nBody = new Int32Array(capacity).fill(-1);
  }

  private grow(extra: number) {
    if (this.nodeCount + extra <= this.cap) return;
    const cap = Math.max(this.cap * 2, this.nodeCount + extra);
    this.cap = cap;
    const center = new Float64Array(cap * 3);
    center.set(this.nCenter);
    this.nCenter = center;
    const half = new Float64Array(cap);
    half.set(this.nHalf);
    this.nHalf = half;
    const mass = new Float64Array(cap);
    mass.set(this.nMass);
    this.nMass = mass;
    const com = new Float64Array(cap * 3);
    com.set(this.nCom);
    this.nCom = com;
    const child = new Int32Array(cap * 8).fill(-1);
    child.set(this.nChild);
    this.nChild = child;
    const childCount = new Uint8Array(cap);
    childCount.set(this.nChildCount);
    this.nChildCount = childCount;
    const body = new Int32Array(cap).fill(-1);
    body.set(this.nBody);
    this.nBody = body;
  }

  build(pos: Float64Array, mass: Float64Array, isTracer: Uint8Array, n: number): void {
    this.nodeCount = 0;
    this.pairCount = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let totalMass = 0;
    for (let i = 0; i < n; i++) {
      if (isTracer[i]) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      totalMass += mass[i];
    }
    if (!isFinite(minX) || totalMass <= 0) return;

    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    let half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5;
    if (!(half > 0)) half = 1;
    half *= 1.001;

    this.resetNodeRoot(cx, cy, cz, half);
    for (let i = 0; i < n; i++) {
      if (isTracer[i]) continue;
      this.insert(0, i, pos, mass, 0);
    }
  }

  private resetNodeRoot(cx: number, cy: number, cz: number, half: number) {
    this.grow(1);
    const r = 0;
    this.nodeCount = 1;
    this.nCenter[0] = cx;
    this.nCenter[1] = cy;
    this.nCenter[2] = cz;
    this.nHalf[r] = half;
    this.nMass[r] = 0;
    this.nCom[0] = this.nCom[1] = this.nCom[2] = 0;
    this.nBody[r] = -1;
    this.nChildCount[r] = 0;
    for (let k = 0; k < 8; k++) this.nChild[k] = -1;
  }

  /** Insert body `b` into the subtree rooted at `node`; accumulators descend. */
  private insert(node: number, b: number, pos: Float64Array, mass: Float64Array, depth: number): void {
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const bm = mass[b];
    // Accumulate on the way down.
    const m0 = this.nMass[node];
    const m1 = m0 + bm;
    this.nMass[node] = m1;
    this.nCom[node * 3] = (this.nCom[node * 3] * m0 + bx * bm) / m1;
    this.nCom[node * 3 + 1] = (this.nCom[node * 3 + 1] * m0 + by * bm) / m1;
    this.nCom[node * 3 + 2] = (this.nCom[node * 3 + 2] * m0 + bz * bm) / m1;

    const existing = this.nBody[node];
    if (existing >= 0) {
      // Occupied leaf: push the incumbent one level down, then continue.
      if (depth >= MAX_DEPTH) {
        this.nBody[node] = -1; // degrade into a multipole leaf
        return;
      }
      this.nBody[node] = -1;
      const ex = pos[existing * 3], ey = pos[existing * 3 + 1], ez = pos[existing * 3 + 2];
      const ci = this.childIndex(node, ex, ey, ez);
      this.insert(this.childOf(node, ci), existing, pos, mass, depth + 1);
    } else if (this.nChildCount[node] === 0) {
      // Empty leaf.
      this.nBody[node] = b;
      return;
    }
    if (depth >= MAX_DEPTH) return;
    const ci = this.childIndex(node, bx, by, bz);
    this.insert(this.childOf(node, ci), b, pos, mass, depth + 1);
  }

  private childIndex(node: number, x: number, y: number, z: number): number {
    const cx = this.nCenter[node * 3], cy = this.nCenter[node * 3 + 1], cz = this.nCenter[node * 3 + 2];
    return (x > cx ? 1 : 0) | (y > cy ? 2 : 0) | (z > cz ? 4 : 0);
  }

  private childOf(node: number, ci: number): number {
    const idx = node * 8 + ci;
    const c = this.nChild[idx];
    if (c !== -1) return c;
    this.grow(1);
    const child = this.nodeCount++;
    const half = this.nHalf[node] * 0.5;
    this.nCenter[child * 3] = this.nCenter[node * 3] + ((ci & 1) ? half : -half);
    this.nCenter[child * 3 + 1] = this.nCenter[node * 3 + 1] + ((ci & 2) ? half : -half);
    this.nCenter[child * 3 + 2] = this.nCenter[node * 3 + 2] + ((ci & 4) ? half : -half);
    this.nHalf[child] = half;
    this.nMass[child] = 0;
    this.nCom[child * 3] = this.nCom[child * 3 + 1] = this.nCom[child * 3 + 2] = 0;
    this.nBody[child] = -1;
    this.nChildCount[child] = 0;
    for (let k = 0; k < 8; k++) this.nChild[child * 8 + k] = -1;
    this.nChild[idx] = child;
    this.nChildCount[node]++;
    return child;
  }

  /** Acceleration on body `i`, accumulated into out[3i..]. Returns pair count. */
  acceleration(i: number, pos: Float64Array, out: Float64Array): number {
    if (this.nodeCount === 0) return 0;
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    let interactions = 0;
    const theta2 = this.theta * this.theta;
    const soft = this.eps2;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    const G = this.G;
    while (sp > 0) {
      const node = stack[--sp];
      const body = this.nBody[node];
      const childCount = this.nChildCount[node];
      const dx = this.nCenter[node * 3] - px;
      const dy = this.nCenter[node * 3 + 1] - py;
      const dz = this.nCenter[node * 3 + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const half = this.nHalf[node];
      if (childCount === 0) {
        // Leaf: single body (or empty).
        if (body >= 0 && body !== i) {
          const rx = this.nCom[node * 3] - px;
          const ry = this.nCom[node * 3 + 1] - py;
          const rz = this.nCom[node * 3 + 2] - pz;
          const r2 = rx * rx + ry * ry + rz * rz + soft;
          const inv = 1 / Math.sqrt(r2);
          const f = G * this.nMass[node] * inv * inv * inv;
          ax += f * rx;
          ay += f * ry;
          az += f * rz;
          interactions++;
        }
        continue;
      }
      if (4 * half * half < theta2 * d2) {
        const rx = this.nCom[node * 3] - px;
        const ry = this.nCom[node * 3 + 1] - py;
        const rz = this.nCom[node * 3 + 2] - pz;
        const r2 = rx * rx + ry * ry + rz * rz + soft;
        const inv = 1 / Math.sqrt(r2);
        const f = G * this.nMass[node] * inv * inv * inv;
        ax += f * rx;
        ay += f * ry;
        az += f * rz;
        interactions++;
        continue;
      }
      const base = node * 8;
      for (let k = 0; k < 8; k++) {
        const c = this.nChild[base + k];
        if (c !== -1 && sp < stack.length) stack[sp++] = c;
      }
    }
    out[i * 3] += ax;
    out[i * 3 + 1] += ay;
    out[i * 3 + 2] += az;
    return interactions;
  }

  get nodes(): number {
    return this.nodeCount;
  }
}
