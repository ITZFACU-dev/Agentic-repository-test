/**
 * Spacetime-curvature grid.
 *
 * A 200×200 plane whose vertices are displaced by the sum of the Flamm
 * paraboloids of every massive body in the scene. WebGL2 has no compute
 * shaders, so the embedding is evaluated per vertex, which is the same work a
 * compute pass would do — and for 40 000 vertices that is free on any GPU.
 */

import * as THREE from 'three';
import gridVert from '../shaders/grid.vert.glsl?raw';
import gridFrag from '../shaders/grid.frag.glsl?raw';
import { glsl } from './HDRPipeline';

const MAX_GRID_LENSES = 16;

export class CurvatureGrid {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private span = 1e13;
  private segments = 200;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: glsl(gridVert, { MAX_LENSES: MAX_GRID_LENSES }),
      fragmentShader: glsl(gridFrag),
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uModel: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uScale: { value: 1 },
        uLensCount: { value: 0 },
        uLensPos: { value: Array.from({ length: MAX_GRID_LENSES }, () => new THREE.Vector3()) },
        uLensMass: { value: new Float32Array(MAX_GRID_LENSES) },
        uGain: { value: 1 },
        uMaxFlare: { value: 1e9 },
        uGridSize: { value: 200 },
        uSpan: { value: 1e13 },
        uTime: { value: 0 },
        uGridColor: { value: new THREE.Color(0.15, 0.35, 0.5) },
        uWellColor: { value: new THREE.Color(0.35, 0.65, 1.0) },
        uOpacity: { value: 0.85 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = this.build(200);
    this.mesh.frustumCulled = false;
    this.segments = 200;
    this.mesh.visible = false;
    this.mesh.renderOrder = -100;
  }

  /** Rebuild the plane at a lower/higher vertex count (quality tiers). */
  setResolution(segments: number): void {
    const clamped = Math.max(64, Math.min(256, Math.round(segments)));
    if (clamped === this.segments) return;
    this.segments = clamped;
    const old = this.mesh.geometry;
    this.mesh.geometry = new THREE.PlaneGeometry(1, 1, clamped, clamped).rotateX(-Math.PI / 2);
    this.mesh.geometry.scale(this.span, 1, this.span);
    old.dispose();
  }

  private build(segments: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(1, 1, segments, segments).rotateX(-Math.PI / 2);
    geo.scale(this.span, 1, this.span);
    return new THREE.Mesh(geo, this.material);
  }

  /** Match the grid to the scale of the current scene (1 AU … 30 kpc). */
  setSpan(metres: number): void {
    this.span = metres;
    this.mesh.scale.setScalar(1);
    this.material.uniforms.uSpan.value = metres;
  }

  get gridSpan(): number {
    return this.span;
  }

  /**
   * Hand the grid the bodies that deform spacetime. Ordinary planets are
   * included: their wells are tiny but they are exactly what the eye looks for
   * when the grid is switched on.
   */
  setBodies(bodies: { id: number; position: THREE.Vector3; mass: number; compact: boolean }[]): void {
    const u = this.material.uniforms;
    const pos = u.uLensPos.value as THREE.Vector3[];
    const mass = u.uLensMass.value as Float32Array;
    const ranked = bodies
      .filter((b) => b.mass > 0)
      .sort((a, b) => b.mass - a.mass)
      .slice(0, MAX_GRID_LENSES);
    for (let i = 0; i < ranked.length; i++) {
      pos[i].copy(ranked[i].position);
      mass[i] = ranked[i].mass;
    }
    u.uLensCount.value = ranked.length;

    // Exaggeration gain: lift the deepest well in the scene to 22 % of the grid
    // span, because a *literal* Flamm paraboloid around a star is invisible at
    // Solar-System scale (the Sun's funnel is ~4×10⁷ m deep at 1 AU inside a
    // 10¹³ m grid). The shape stays exact; only the vertical scale is artistic.
    const G_EARTH = 6.6743e-11;
    const C2 = 2.99792458e8 ** 2;
    let maxFlare = 0;
    for (const body of ranked) {
      const rs = (2 * G_EARTH * body.mass) / C2;
      const r = Math.max(rs * 6, Math.min(this.span * 0.05, this.span * 0.4));
      maxFlare = Math.max(maxFlare, 2 * Math.sqrt(Math.max(rs * (r - rs), 0)));
    }
    if (maxFlare > 0) {
      u.uMaxFlare.value = maxFlare;
      u.uGain.value = (this.span * 0.22) / maxFlare;
    }
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  setCameraUniforms(viewProjection: THREE.Matrix4, cameraPosition: THREE.Vector3, time: number): void {
    (this.material.uniforms.uViewProjection.value as THREE.Matrix4).copy(viewProjection);
    (this.material.uniforms.uCameraPosition.value as THREE.Vector3).copy(cameraPosition);
    this.material.uniforms.uTime.value = time;
  }

  setOpacity(value: number): void {
    this.material.uniforms.uOpacity.value = value;
  }
}
