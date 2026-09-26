/**
 * HDR starfield.
 *
 * A single inverted sphere drawn at the far plane with depth testing disabled.
 * The star catalogue is generated on the GPU from an octahedral hash — no
 * textures, no downloads, and it stays physically consistent (blackbody colours,
 * power-law magnitudes, a Milky Way band with dust lanes) as the camera turns.
 *
 * Eye adaptation lives in the tone-mapping pass, so the same field can look
 * like a night sky or be blown out next to a star: exactly the point of the
 * HDR pipeline.
 */

import * as THREE from 'three';
import starVert from '../shaders/starfield.vert.glsl?raw';
import starFrag from '../shaders/starfield.frag.glsl?raw';
import { glsl } from './HDRPipeline';

export class Starfield {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: glsl(starVert),
      fragmentShader: glsl(starFrag),
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uRadius: { value: 1 },
        uDensity: { value: 0.35 },
        uBrightness: { value: 1.5 },
        uSeed: { value: 17.0 },
        uNebula: { value: 0.6 },
        uMilkyWay: { value: 1.0 },
        uGalacticBasis: { value: new THREE.Matrix3() },
      },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.setGalacticPlane(72, 12);
  }

  /** Orient the Milky Way band, in degrees (galactic-plane pole). */
  setGalacticPlane(galacticLongitudeDeg: number, galacticLatitudeDeg: number): void {
    const pole = new THREE.Vector3(
      Math.cos(THREE.MathUtils.degToRad(galacticLatitudeDeg)) * Math.cos(THREE.MathUtils.degToRad(galacticLongitudeDeg)),
      Math.sin(THREE.MathUtils.degToRad(galacticLatitudeDeg)),
      Math.cos(THREE.MathUtils.degToRad(galacticLatitudeDeg)) * Math.sin(THREE.MathUtils.degToRad(galacticLongitudeDeg)),
    ).normalize();
    const ref = Math.abs(pole.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(ref, pole).normalize();
    const y = new THREE.Vector3().crossVectors(pole, x).normalize();
    const basis = new THREE.Matrix3().set(x.x, x.y, x.z, y.x, y.y, y.z, pole.x, pole.y, pole.z);
    this.material.uniforms.uGalacticBasis.value = basis;
  }

  setViewProjection(viewProjection: THREE.Matrix4): void {
    (this.material.uniforms.uViewProjection.value as THREE.Matrix4).copy(viewProjection);
  }

  setBrightness(value: number): void {
    this.material.uniforms.uBrightness.value = value;
  }

  setDensity(value: number): void {
    this.material.uniforms.uDensity.value = value;
  }

  setNebula(value: number): void {
    this.material.uniforms.uNebula.value = value;
  }

  setMilkyWay(value: number): void {
    this.material.uniforms.uMilkyWay.value = value;
  }
}
