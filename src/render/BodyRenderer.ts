/**
 * Procedural bodies.
 *
 * Every body in the simulation is drawn by a single instanced draw call: one
 * low-poly icosphere, and per-instance attributes carrying position, radius,
 * temperature, flags and seed. Surface detail is generated in the fragment
 * shader (see body.frag.glsl), so a 300-body scene costs one draw call and no
 * texture memory at all.
 */

import * as THREE from 'three';
import bodyVert from '../shaders/body.vert.glsl?raw';
import bodyFrag from '../shaders/body.frag.glsl?raw';
import atmosVert from '../shaders/atmosphere.vert.glsl?raw';
import atmosFrag from '../shaders/atmosphere.frag.glsl?raw';
import ringVert from '../shaders/ring.vert.glsl?raw';
import ringFrag from '../shaders/ring.frag.glsl?raw';
import { glsl } from './HDRPipeline';
import { clamp } from '../core/mathx';

const FLAG_ATMOSPHERE = 1 << 2;

class InstancedSet {
  readonly geometry = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;

  constructor(geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial) {
    const g = this.geometry;
    g.index = geometry.index;
    g.setAttribute('position', geometry.getAttribute('position'));
    if (geometry.getAttribute('normal')) g.setAttribute('normal', geometry.getAttribute('normal'));
    if (geometry.getAttribute('uv')) g.setAttribute('uv', geometry.getAttribute('uv'));
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false; // instance positions are not in the bounds
  }
}

export class BodyRenderer {
  readonly group = new THREE.Group();
  readonly bodies: InstancedSet;
  readonly atmospheres: InstancedSet;
  readonly rings: InstancedSet;

  private capacity: number;

  // Per-instance attribute buffers (grown together with the capacity).
  private aPosition!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;
  private aRadius!: THREE.InstancedBufferAttribute;
  private aTemp!: THREE.InstancedBufferAttribute;
  private aFlags!: THREE.InstancedBufferAttribute;
  private aSeed!: THREE.InstancedBufferAttribute;
  private aSpin!: THREE.InstancedBufferAttribute;
  private aSpinAxis!: THREE.InstancedBufferAttribute;
  private aAccel!: THREE.InstancedBufferAttribute;

  private atPosition!: THREE.InstancedBufferAttribute;
  private atTint!: THREE.InstancedBufferAttribute;
  private atRadius!: THREE.InstancedBufferAttribute;
  private atTemp!: THREE.InstancedBufferAttribute;
  private atFlags!: THREE.InstancedBufferAttribute;
  private atSeed!: THREE.InstancedBufferAttribute;
  private aAtmos!: THREE.InstancedBufferAttribute;
  private aAtmosRadius!: THREE.InstancedBufferAttribute;

  private rOffset!: THREE.InstancedBufferAttribute;
  private rSize!: THREE.InstancedBufferAttribute;
  private rTemp!: THREE.InstancedBufferAttribute;
  private rHost!: THREE.InstancedBufferAttribute;

  readonly bodyMaterial: THREE.ShaderMaterial;
  readonly atmosMaterial: THREE.ShaderMaterial;
  readonly ringMaterial: THREE.ShaderMaterial;

  private spinPhase = 0;
  exaggeration = 1;
  rotationSpeed = 1;
  surfaceDetail = 1;

  constructor(capacity = 512) {
    this.capacity = capacity;
    const sphere = new THREE.IcosahedronGeometry(1, 3);
    const quad = new THREE.PlaneGeometry(2, 2);

    this.bodyMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl(bodyVert),
      fragmentShader: glsl(bodyFrag),
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uScale: { value: 1 },
        uTime: { value: 0 },
        uExaggeration: { value: 1 },
        uRotationSpeed: { value: 1 },
        uSunPos: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunIntensity: { value: 1 },
        uAmbient: { value: new THREE.Color(0.03, 0.035, 0.05) },
        uLavaThreshold: { value: 1100 },
        uSurfaceDetail: { value: 1 },
      },
    });
    this.atmosMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl(atmosVert),
      fragmentShader: glsl(atmosFrag),
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uScale: { value: 1 },
        uExaggeration: { value: 1 },
        uSunPos: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunIntensity: { value: 1 },
        uDensity: { value: 1 },
        uBetaR: { value: 1 },
        uBetaM: { value: 1 },
        uGroundFade: { value: 0 },
        uViewSamples: { value: 12 },
        uLightSamples: { value: 6 },
      },
      transparent: true,
      depthWrite: false,
      // Front faces: the shell is drawn between the camera and the planet, and
      // the shader itself stops the ray at the ground, so one pass is enough.
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    });
    this.ringMaterial = new THREE.ShaderMaterial({
      vertexShader: glsl(ringVert),
      fragmentShader: glsl(ringFrag),
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uScale: { value: 1 },
        uSunPos: { value: new THREE.Vector3() },
        uSunIntensity: { value: 1 },
        uTint: { value: new THREE.Color(0.75, 0.65, 0.5) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.bodies = new InstancedSet(sphere, this.bodyMaterial);
    this.atmospheres = new InstancedSet(sphere, this.atmosMaterial);
    this.rings = new InstancedSet(quad, this.ringMaterial);
    this.group.add(this.bodies.mesh, this.atmospheres.mesh, this.rings.mesh);
    this.allocate(capacity);
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    const f32 = (n: number) => new Float32Array(n);
    this.aPosition = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.aTint = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.aRadius = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.aTemp = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.aFlags = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.aSeed = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.aSpin = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.aSpinAxis = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.aAccel = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.atPosition = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.atTint = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.atRadius = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.atTemp = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.atFlags = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.atSeed = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.aAtmos = new THREE.InstancedBufferAttribute(f32(capacity * 3), 3);
    this.aAtmosRadius = new THREE.InstancedBufferAttribute(f32(capacity), 1);
    this.rOffset = new THREE.InstancedBufferAttribute(f32(Math.max(capacity, 256) * 3), 3);
    this.rSize = new THREE.InstancedBufferAttribute(f32(Math.max(capacity, 256)), 1);
    this.rTemp = new THREE.InstancedBufferAttribute(f32(Math.max(capacity, 256)), 1);
    this.rHost = new THREE.InstancedBufferAttribute(f32(Math.max(capacity, 256) * 3), 3);

    const setAll = () => {
      const g = this.bodies.geometry;
      g.setAttribute('aPosition', this.aPosition);
      g.setAttribute('aTint', this.aTint);
      g.setAttribute('aRadius', this.aRadius);
      g.setAttribute('aTemp', this.aTemp);
      g.setAttribute('aFlags', this.aFlags);
      g.setAttribute('aSeed', this.aSeed);
      g.setAttribute('aSpin', this.aSpin);
      g.setAttribute('aSpinAxis', this.aSpinAxis);
      g.setAttribute('aAccel', this.aAccel);
      const ag = this.atmospheres.geometry;
      ag.setAttribute('aPosition', this.atPosition);
      ag.setAttribute('aTint', this.atTint);
      ag.setAttribute('aRadius', this.atRadius);
      ag.setAttribute('aTemp', this.atTemp);
      ag.setAttribute('aFlags', this.atFlags);
      ag.setAttribute('aSeed', this.atSeed);
      ag.setAttribute('aAtmos', this.aAtmos);
      ag.setAttribute('aAtmosRadius', this.aAtmosRadius);
      const rg = this.rings.geometry;
      rg.setAttribute('aHost', this.rHost);
      rg.setAttribute('aOffset', this.rOffset);
      rg.setAttribute('aSize', this.rSize);
      rg.setAttribute('aTemp', this.rTemp);
    };
    setAll();
  }

  /** Radii are multiplied by this for readability when zoomed out. */
  setExaggeration(value: number): void {
    this.exaggeration = value;
  }

  /**
   * Upload a snapshot. Positions arrive as absolute metres in float32; the
   * shader subtracts the camera position, so no per-body CPU work is needed.
   */
  update(snapshot: {
    count: number;
    pos: Float32Array;
    radii: Float32Array;
    temp: Float32Array;
    flags: Uint8Array;
    tint: Float32Array;
    atmos: Float32Array;
    ids: Int32Array;
  }, dt: number): void {
    const n = snapshot.count;
    if (n > this.capacity) this.allocate(Math.max(n, this.capacity * 2));
    this.spinPhase += dt * this.rotationSpeed;

    const pos = this.aPosition.array as Float32Array;
    const tint = this.aTint.array as Float32Array;
    const radius = this.aRadius.array as Float32Array;
    const temp = this.aTemp.array as Float32Array;
    const flags = this.aFlags.array as Float32Array;
    const seed = this.aSeed.array as Float32Array;
    const spin = this.aSpin.array as Float32Array;
    const axis = this.aSpinAxis.array as Float32Array;
    const accel = this.aAccel.array as Float32Array;
    const atmos = this.aAtmos.array as Float32Array;
    const atmosRadius = this.aAtmosRadius.array as Float32Array;

    for (let i = 0; i < n; i++) {
      pos[i * 3] = snapshot.pos[i * 3];
      pos[i * 3 + 1] = snapshot.pos[i * 3 + 1];
      pos[i * 3 + 2] = snapshot.pos[i * 3 + 2];
      tint[i * 3] = snapshot.tint[i * 3];
      tint[i * 3 + 1] = snapshot.tint[i * 3 + 1];
      tint[i * 3 + 2] = snapshot.tint[i * 3 + 2];
      radius[i] = snapshot.radii[i];
      temp[i] = snapshot.temp[i];
      flags[i] = snapshot.flags[i];
      // A stable procedural seed derived from the body id: the same planet
      // always gets the same continents.
      const id = snapshot.ids[i];
      seed[i] = (id * 2654435761) % 100000;
      // A body spins once per `spinPeriod`; the physics worker owns the real
      // rate, here it only drives the visible rotation of the surface texture.
      spin[i] = this.spinPhase * (0.02 + (seed[i] % 1000) / 5000);
      accel[i * 3] = 0;
      accel[i * 3 + 1] = 0;
      accel[i * 3 + 2] = 0;
      axis[i * 3] = 0;
      axis[i * 3 + 1] = 0;
      axis[i * 3 + 2] = 1;
      const scaleHeight = snapshot.atmos[i * 3];
      atmos[i * 3] = scaleHeight;
      atmos[i * 3 + 1] = snapshot.atmos[i * 3 + 1];
      atmos[i * 3 + 2] = snapshot.atmos[i * 3 + 2];
      const r = snapshot.radii[i];
      atmosRadius[i] = (snapshot.flags[i] & FLAG_ATMOSPHERE) !== 0 ? r + Math.max(6 * scaleHeight, r * 0.04) : r;
    }
    this.bodies.geometry.instanceCount = n;

    // Atmospheres are a compacted subset: only bodies that actually have one.
    const atPos = this.atPosition.array as Float32Array;
    const atTint = this.atTint.array as Float32Array;
    const atRadius = this.atRadius.array as Float32Array;
    const atTemp = this.atTemp.array as Float32Array;
    const atFlags = this.atFlags.array as Float32Array;
    const atSeed = this.atSeed.array as Float32Array;
    const atAtmos = this.aAtmos.array as Float32Array;
    const atAtmosRadius = this.aAtmosRadius.array as Float32Array;
    let atmosphereCount = 0;
    for (let i = 0; i < n; i++) {
      if ((snapshot.flags[i] & FLAG_ATMOSPHERE) === 0) continue;
      const d = atmosphereCount++;
      atPos[d * 3] = snapshot.pos[i * 3];
      atPos[d * 3 + 1] = snapshot.pos[i * 3 + 1];
      atPos[d * 3 + 2] = snapshot.pos[i * 3 + 2];
      atTint[d * 3] = snapshot.tint[i * 3];
      atTint[d * 3 + 1] = snapshot.tint[i * 3 + 1];
      atTint[d * 3 + 2] = snapshot.tint[i * 3 + 2];
      atRadius[d] = snapshot.radii[i];
      atTemp[d] = snapshot.temp[i];
      atFlags[d] = snapshot.flags[i];
      atSeed[d] = seed[i];
      const scaleHeight = snapshot.atmos[i * 3];
      atAtmos[d * 3] = scaleHeight;
      atAtmos[d * 3 + 1] = snapshot.atmos[i * 3 + 1];
      atAtmos[d * 3 + 2] = snapshot.atmos[i * 3 + 2];
      const r = snapshot.radii[i];
      atAtmosRadius[d] = r + Math.max(6 * scaleHeight, r * 0.04);
    }
    this.atmospheres.geometry.instanceCount = atmosphereCount;

    this.markDirty();
  }

  /** Upload ring / debris particles (host position + body-space offset). */
  updateParticles(
    particles: { positions: Float32Array; sizes: Float32Array; temps: Float32Array; hostIds: Int32Array; count: number } | null,
    hostPositions: Float32Array,
  ): void {
    const count = particles?.count ?? 0;
    if (count > this.rSize.array.length) {
      const grow = Math.max(count, this.rSize.array.length * 2);
      this.rOffset = new THREE.InstancedBufferAttribute(new Float32Array(grow * 3), 3);
      this.rSize = new THREE.InstancedBufferAttribute(new Float32Array(grow), 1);
      this.rTemp = new THREE.InstancedBufferAttribute(new Float32Array(grow), 1);
      this.rHost = new THREE.InstancedBufferAttribute(new Float32Array(grow * 3), 3);
      const rg = this.rings.geometry;
      rg.setAttribute('aHost', this.rHost);
      rg.setAttribute('aOffset', this.rOffset);
      rg.setAttribute('aSize', this.rSize);
      rg.setAttribute('aTemp', this.rTemp);
    }
    if (count > 0 && particles) {
      const off = this.rOffset.array as Float32Array;
      const size = this.rSize.array as Float32Array;
      const t = this.rTemp.array as Float32Array;
      const host = this.rHost.array as Float32Array;
      for (let i = 0; i < count; i++) {
        const h = particles.hostIds[i];
        off[i * 3] = particles.positions[i * 3];
        off[i * 3 + 1] = particles.positions[i * 3 + 1];
        off[i * 3 + 2] = particles.positions[i * 3 + 2];
        size[i] = particles.sizes[i];
        t[i] = particles.temps[i];
        host[i * 3] = hostPositions[h * 3] ?? 0;
        host[i * 3 + 1] = hostPositions[h * 3 + 1] ?? 0;
        host[i * 3 + 2] = hostPositions[h * 3 + 2] ?? 0;
      }
      this.rHost.needsUpdate = true;
      this.rOffset.needsUpdate = true;
      this.rSize.needsUpdate = true;
      this.rTemp.needsUpdate = true;
    }
    this.rings.geometry.instanceCount = count;
  }

  private markDirty(): void {
    for (const a of [
      this.aPosition,
      this.aTint,
      this.aRadius,
      this.aTemp,
      this.aFlags,
      this.aSeed,
      this.aSpin,
      this.aSpinAxis,
      this.aAtmos,
      this.aAtmosRadius,
      this.atPosition,
      this.atTint,
      this.atRadius,
      this.atTemp,
      this.atFlags,
      this.atSeed,
    ]) {
      a.needsUpdate = true;
    }
  }

  /** Point the shaders at the dominant light source (the brightest star). */
  setSun(position: THREE.Vector3, color: THREE.Color, intensity: number): void {
    (this.ringMaterial.uniforms.uSunPos.value as THREE.Vector3).copy(position);
    this.ringMaterial.uniforms.uSunIntensity.value = intensity;
    for (const m of [this.bodyMaterial, this.atmosMaterial]) {
      (m.uniforms.uSunPos.value as THREE.Vector3).copy(position);
      (m.uniforms.uSunColor.value as THREE.Color).copy(color);
      m.uniforms.uSunIntensity.value = intensity;
    }
  }

  setCameraUniforms(viewProjection: THREE.Matrix4, cameraPosition: THREE.Vector3, time: number): void {
    for (const m of [this.bodyMaterial, this.atmosMaterial, this.ringMaterial]) {
      (m.uniforms.uViewProjection.value as THREE.Matrix4).copy(viewProjection);
      (m.uniforms.uCameraPosition.value as THREE.Vector3).copy(cameraPosition);
    }
    this.bodyMaterial.uniforms.uTime.value = time;
    this.bodyMaterial.uniforms.uExaggeration.value = this.exaggeration;
    this.bodyMaterial.uniforms.uRotationSpeed.value = this.rotationSpeed;
    this.bodyMaterial.uniforms.uSurfaceDetail.value = this.surfaceDetail;
    this.atmosMaterial.uniforms.uExaggeration.value = this.exaggeration;
  }

  setAtmosphereQuality(viewSamples: number, lightSamples: number, density: number): void {
    this.atmosMaterial.uniforms.uViewSamples.value = clamp(Math.round(viewSamples), 1, 32);
    this.atmosMaterial.uniforms.uLightSamples.value = clamp(Math.round(lightSamples), 1, 16);
    this.atmosMaterial.uniforms.uDensity.value = density;
  }

  /**
   * Optical-depth multipliers: the "thickness" of every atmosphere at once.
   * β_r drives the blue sky and the sunset red; β_m drives the forward-scattered
   * aureole around the sun. Both are physical coefficients in the shader, so
   * this is the same knob a climate modeller would turn.
   */
  setAtmosphereOptics(betaR: number, betaM: number): void {
    this.atmosMaterial.uniforms.uBetaR.value = clamp(betaR, 0, 8);
    this.atmosMaterial.uniforms.uBetaM.value = clamp(betaM, 0, 8);
  }

  get sunPosition(): THREE.Vector3 {
    return this.bodyMaterial.uniforms.uSunPos.value as THREE.Vector3;
  }
}
