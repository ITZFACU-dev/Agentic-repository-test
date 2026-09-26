/**
 * Educational overlays: velocity / force / acceleration vectors, orbit trails,
 * the selected body's osculating Kepler ellipse, Lagrange markers and the
 * habitable-zone ribbons.
 *
 * These are drawn with three's own materials (not the camera-relative custom
 * shaders) because they are annotations, not scene geometry: they should not be
 * lensed, bloomed or occluded by the physics bodies.
 */

import * as THREE from 'three';
import hzVert from '../shaders/hz.vert.glsl?raw';
import hzFrag from '../shaders/hz.frag.glsl?raw';
import { glsl } from './HDRPipeline';
import { AU, SOLAR_LUMINOSITY } from '../core/units';

const HZ_BANDS = {
  /** Kopparapu-style flux limits (relative to Earth's 1361 W/m²). */
  recentVenus: 1.776,
  runaway: 0.99,
  maxGreenhouse: 0.356,
  earlyMars: 0.32,
};

interface Trail {
  id: number;
  line: THREE.Line;
  positions: Float32Array;
  capacity: number;
  head: number;
  filled: number;
  color: THREE.Color;
}

export class OverlayRenderer {
  readonly group = new THREE.Group();
  readonly trailsGroup = new THREE.Group();
  readonly hzGroup = new THREE.Group();
  private trails = new Map<number, Trail>();
  private vectorVelocity: THREE.ArrowHelper;
  private vectorForce: THREE.ArrowHelper;
  private vectorAccel: THREE.ArrowHelper;
  private keplerLine: THREE.Line;
  private keplerPositions = new Float32Array(362 * 3);
  private lagrangeGroup = new THREE.Group();
  private lagrangeMeshes: THREE.Mesh[] = [];
  private lagrangeLabels: string[] = [];

  showVelocity = true;
  showForce = true;
  showAccel = false;
  showTrails = true;
  showKepler = true;
  showLagrange = true;
  showHabitability = false;
  trailLength = 900;
  vectorScale = 1;

  readonly hzMaterial: THREE.ShaderMaterial;
  readonly hzMesh: THREE.Mesh;

  constructor() {
    const arrow = (color: number, name: string) => {
      const helper = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, color, 0.28, 0.16);
      helper.name = name;
      helper.visible = false;
      (helper.line.material as THREE.LineBasicMaterial).linewidth = 2;
      (helper.line.material as THREE.LineBasicMaterial).depthTest = false;
      (helper.cone.material as THREE.MeshBasicMaterial).depthTest = false;
      helper.renderOrder = 900;
      return helper;
    };
    this.vectorVelocity = arrow(0x53b6ff, 'velocity');
    this.vectorForce = arrow(0xff6a4d, 'force');
    this.vectorAccel = arrow(0x6dff9e, 'acceleration');
    this.group.add(this.vectorVelocity, this.vectorForce, this.vectorAccel);

    const keplerGeo = new THREE.BufferGeometry();
    keplerGeo.setAttribute('position', new THREE.BufferAttribute(this.keplerPositions, 3));
    this.keplerLine = new THREE.Line(
      keplerGeo,
      new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.65, depthTest: false }),
    );
    this.keplerLine.frustumCulled = false;
    this.keplerLine.renderOrder = 890;
    this.keplerLine.visible = false;
    this.group.add(this.keplerLine);

    const markerGeo = new THREE.SphereGeometry(1, 12, 8);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xffe27a, depthTest: false, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.frustumCulled = false;
      m.renderOrder = 895;
      m.visible = false;
      this.lagrangeGroup.add(m);
      this.lagrangeMeshes.push(m);
    }
    this.group.add(this.lagrangeGroup);

    this.hzMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl(hzVert),
      fragmentShader: glsl(hzFrag),
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uScale: { value: 1 },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.RingGeometry(0.7, 1.0, 160, 4);
    ring.rotateX(-Math.PI / 2);
    const hzGeo = new THREE.InstancedBufferGeometry();
    hzGeo.index = ring.index;
    hzGeo.setAttribute('position', ring.getAttribute('position'));
    hzGeo.setAttribute('uv', ring.getAttribute('uv'));
    hzGeo.instanceCount = 0;
    this.hzMesh = new THREE.Mesh(hzGeo, this.hzMaterial);
    this.hzMesh.frustumCulled = false;
    this.hzMesh.renderOrder = 200;
    this.hzMesh.visible = false;
    this.group.add(this.hzMesh);

    this.group.add(this.trailsGroup);
    this.group.add(this.hzGroup);
  }

  // ── Habitable zones ───────────────────────────────────────────────────────

  private hzCapacity = 0;

  /**
   * Add a conservative and an optimistic ribbon around every luminous body.
   * Radii scale as √(L/L☉) because flux falls as 1/r².
   */
  setHabitableZones(stars: { position: THREE.Vector3; luminosity: number; axis: THREE.Vector3 }[]): void {
    const wanted = stars.filter((s) => s.luminosity > 0).slice(0, 64);
    const instances = wanted.length * 2;
    if (instances > this.hzCapacity) {
      const cap = Math.max(instances, 8);
      const geo = this.hzMesh.geometry as THREE.InstancedBufferGeometry;
      const aCenter = new Float32Array(cap * 3);
      const aAxis = new Float32Array(cap * 3);
      const aInner = new Float32Array(cap);
      const aOuter = new Float32Array(cap);
      const aColor = new Float32Array(cap * 3);
      const aMode = new Float32Array(cap);
      geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(aCenter, 3));
      geo.setAttribute('aAxis', new THREE.InstancedBufferAttribute(aAxis, 3));
      geo.setAttribute('aInner', new THREE.InstancedBufferAttribute(aInner, 1));
      geo.setAttribute('aOuter', new THREE.InstancedBufferAttribute(aOuter, 1));
      geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
      geo.setAttribute('aMode', new THREE.InstancedBufferAttribute(aMode, 1));
      this.hzCapacity = cap;
    }
    const geo = this.hzMesh.geometry as THREE.InstancedBufferGeometry;
    const aCenter = geo.getAttribute('aCenter').array as Float32Array;
    const aAxis = geo.getAttribute('aAxis').array as Float32Array;
    const aInner = geo.getAttribute('aInner').array as Float32Array;
    const aOuter = geo.getAttribute('aOuter').array as Float32Array;
    const aColor = geo.getAttribute('aColor').array as Float32Array;
    const aMode = geo.getAttribute('aMode').array as Float32Array;
    let w = 0;
    for (const star of wanted) {
      const scale = Math.sqrt(star.luminosity / SOLAR_LUMINOSITY);
      const rInner = Math.sqrt(1 / HZ_BANDS.runaway) * AU * scale;
      const rOuter = Math.sqrt(1 / HZ_BANDS.maxGreenhouse) * AU * scale;
      const optInner = Math.sqrt(1 / HZ_BANDS.recentVenus) * AU * scale;
      const optOuter = Math.sqrt(1 / HZ_BANDS.earlyMars) * AU * scale;
      const bands: [number, number, number, number][] = [
        [rInner, rOuter, 0.35, 0.95],
        [optInner, rInner, optOuter > 0 ? 1 : 1, 0.55],
        [rOuter, optOuter, 1, 0.45],
      ];
      for (const [inner, outer, mode, alpha] of bands) {
        if (outer <= inner) continue;
        aCenter[w * 3] = star.position.x;
        aCenter[w * 3 + 1] = star.position.y;
        aCenter[w * 3 + 2] = star.position.z;
        aAxis[w * 3] = star.axis.x;
        aAxis[w * 3 + 1] = star.axis.y;
        aAxis[w * 3 + 2] = star.axis.z;
        aInner[w] = inner;
        aOuter[w] = outer;
        // Conservative = green, optimistic = amber.
        const conservative = mode === 0;
        aColor[w * 3] = conservative ? 0.25 : 0.85;
        aColor[w * 3 + 1] = conservative ? 0.85 : 0.62;
        aColor[w * 3 + 2] = conservative ? 0.45 : 0.2;
        aMode[w] = mode;
        void alpha;
        w++;
      }
    }
    geo.instanceCount = w;
    for (const name of ['aCenter', 'aAxis', 'aInner', 'aOuter', 'aColor', 'aMode']) {
      geo.getAttribute(name).needsUpdate = true;
    }
  }

  // ── Lagrange markers ──────────────────────────────────────────────────────

  setLagrange(points: { id: string; pos: [number, number, number] }[] | null, scale: number): void {
    this.lagrangeLabels = [];
    for (let i = 0; i < this.lagrangeMeshes.length; i++) {
      const m = this.lagrangeMeshes[i];
      const p = points?.[i];
      if (!p || !this.showLagrange) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(p.pos[0], p.pos[1], p.pos[2]);
      m.scale.setScalar(Math.max(scale * 0.012, 1));
      this.lagrangeLabels.push(p.id);
    }
  }

  get lagrangeMarkers(): { label: string; position: THREE.Vector3 }[] {
    const out: { label: string; position: THREE.Vector3 }[] = [];
    this.lagrangeMeshes.forEach((m, i) => {
      if (m.visible && this.lagrangeLabels[i]) out.push({ label: this.lagrangeLabels[i], position: m.position.clone() });
    });
    return out;
  }

  // ── Trails ────────────────────────────────────────────────────────────────

  addTrail(id: number, color: THREE.Color): void {
    if (this.trails.has(id)) return;
    const capacity = Math.max(64, this.trailLength);
    const positions = new Float32Array(capacity * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }));
    line.frustumCulled = false;
    line.renderOrder = 880;
    this.trailsGroup.add(line);
    this.trails.set(id, { id, line, positions, capacity, head: 0, filled: 0, color });
  }

  clearTrails(): void {
    for (const t of this.trails.values()) {
      this.trailsGroup.remove(t.line);
      t.line.geometry.dispose();
      (t.line.material as THREE.Material).dispose();
    }
    this.trails.clear();
  }

  /** Push one sample per tracked body; the trail is drawn as a ring buffer. */
  pushTrail(id: number, position: THREE.Vector3): void {
    const t = this.trails.get(id);
    if (!t) return;
    const i = t.head;
    t.positions[i * 3] = position.x;
    t.positions[i * 3 + 1] = position.y;
    t.positions[i * 3 + 2] = position.z;
    t.head = (t.head + 1) % t.capacity;
    t.filled = Math.min(t.filled + 1, t.capacity);
    const attr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    // Simple approach: always draw from the oldest sample to the newest, so the
    // trail "grows" until it wraps and then scrolls.
    t.line.geometry.setDrawRange(0, t.filled);
  }

  setTrailsVisible(visible: boolean): void {
    this.trailsGroup.visible = visible;
  }

  // ── Vectors ───────────────────────────────────────────────────────────────

  /**
   * Draw the three physical vectors on the selected body, with logarithmic
   * scaling so a 0.01 m/s² nudge and a 300 m/s² slingshot are both readable.
   */
  setVectors(
    position: THREE.Vector3,
    vel: THREE.Vector3,
    acc: THREE.Vector3,
    force: THREE.Vector3,
    referenceLength: number,
  ): void {
    const set = (helper: THREE.ArrowHelper, value: THREE.Vector3, scale: number, minLength: number) => {
      const magnitude = value.length();
      if (!this.showVelocity && helper === this.vectorVelocity) return;
      if (magnitude <= 0) {
        helper.visible = false;
        return;
      }
      helper.visible = true;
      helper.position.copy(position);
      helper.setDirection(value.clone().normalize());
      // Log scaling keeps both tiny and enormous magnitudes on screen.
      const length = minLength * (1 + Math.log10(1 + magnitude * scale));
      helper.setLength(length, length * 0.22, length * 0.11);
    };
    const ref = referenceLength;
    if (this.showVelocity) set(this.vectorVelocity, vel, 1.5, ref * 0.12);
    else this.vectorVelocity.visible = false;
    if (this.showAccel) set(this.vectorAccel, acc, 2, ref * 0.12);
    else this.vectorAccel.visible = false;
    if (this.showForce) set(this.vectorForce, force, 1e-3, ref * 0.12);
    else this.vectorForce.visible = false;
  }

  hideVectors(): void {
    this.vectorVelocity.visible = false;
    this.vectorForce.visible = false;
    this.vectorAccel.visible = false;
  }

  // ── Kepler ellipse ────────────────────────────────────────────────────────

  /**
   * The osculating orbit of the selected body: r(ν) = a(1−e²)/(1 + e cos ν),
   * rotated into the orbital plane. Drawing it makes the instantaneous
   * elements tangible — the ellipse flexes as the body is perturbed.
   */
  setKeplerOrbit(
    primary: THREE.Vector3,
    elements: { a: number; e: number; i: number; argPeriapsis: number; ascendingNode: number } | null,
  ): void {
    if (!elements || !this.showKepler || !(elements.a > 0)) {
      this.keplerLine.visible = false;
      return;
    }
    const { a, e, i, argPeriapsis, ascendingNode } = elements;
    if (e >= 1 || a <= 0) {
      this.keplerLine.visible = false;
      return;
    }
    const p = a * (1 - e * e);
    const cosN = Math.cos(ascendingNode);
    const sinN = Math.sin(ascendingNode);
    const cosI = Math.cos(i);
    const sinI = Math.sin(i);
    const cosW = Math.cos(argPeriapsis);
    const sinW = Math.sin(argPeriapsis);
    for (let k = 0; k <= 360; k++) {
      const nu = (k / 360) * Math.PI * 2;
      const r = p / (1 + e * Math.cos(nu));
      // Perifocal → inertial.
      const xp = r * Math.cos(nu);
      const yp = r * Math.sin(nu);
      const x = (cosN * cosW - sinN * sinW * cosI) * xp + (-cosN * sinW - sinN * cosW * cosI) * yp;
      const y = (sinN * cosW + cosN * sinW * cosI) * xp + (-sinN * sinW + cosN * cosW * cosI) * yp;
      const z = sinW * sinI * xp + cosW * sinI * yp;
      this.keplerPositions[k * 3] = primary.x + x;
      this.keplerPositions[k * 3 + 1] = primary.y + y;
      this.keplerPositions[k * 3 + 2] = primary.z + z;
    }
    (this.keplerLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.keplerLine.geometry.setDrawRange(0, 361);
    this.keplerLine.visible = true;
  }

  setCameraUniforms(viewProjection: THREE.Matrix4, cameraPosition: THREE.Vector3, time: number): void {
    (this.hzMaterial.uniforms.uViewProjection.value as THREE.Matrix4).copy(viewProjection);
    (this.hzMaterial.uniforms.uCameraPosition.value as THREE.Vector3).copy(cameraPosition);
    this.hzMaterial.uniforms.uTime.value = time;
    this.hzMesh.visible = this.showHabitability;
  }
}
