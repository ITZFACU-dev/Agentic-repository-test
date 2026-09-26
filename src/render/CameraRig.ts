/**
 * Camera rig.
 *
 * An orbit camera that can lock onto any body and follow it, with the numeric
 * range of a real solar system (metres everywhere) handled by adaptive near and
 * far planes: they track the size of whatever is being looked at, so zooming
 * from a 6 371 km planet to a 30 AU orbit never produces z-fighting.
 *
 * The rig also owns the camera-relative rendering convention: `viewProjection`
 * is `projection * rotationOnly(view)`, and every custom shader subtracts
 * `cameraPosition` before transforming, which keeps float32 precision usable at
 * interplanetary distances.
 */

import * as THREE from 'three';
import { clamp } from '../core/mathx';

export interface CameraTarget {
  position: THREE.Vector3;
  radius: number;
}

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(52, 1, 1, 1e13);

  /** Point the camera orbits around, in world metres. */
  readonly target = new THREE.Vector3();
  /** Smoothed target, so a fast-moving body does not shake the view. */
  private readonly smoothTarget = new THREE.Vector3();
  private readonly followPoint = new THREE.Vector3();
  private followId = -1;
  followEnabled = true;

  distance = 3e10;
  private targetDistance = 3e10;
  azimuth = 0.6;
  private targetAzimuth = 0.6;
  elevation = 0.35;
  private targetElevation = 0.35;

  autoRotate = 0;
  minDistance = 1;
  maxDistance = 1e24;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastPointerButton = 0;
  private readonly keys = new Set<string>();

  /** Camera-relative view-projection, refreshed every frame. */
  readonly viewProjection = new THREE.Matrix4();
  private readonly viewRotation = new THREE.Matrix4();
  readonly cameraPosition = new THREE.Vector3();
  focusRadius = 6.4e6;

  constructor(private readonly domElement: HTMLElement) {
    this.bindEvents();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Frame a body: target it and pick a distance from its radius. */
  focusOn(id: number, position: THREE.Vector3, radius: number, distanceFactor = 6): void {
    this.followId = id;
    this.followPoint.copy(position);
    this.focusRadius = Math.max(radius, 1);
    this.targetDistance = clamp(radius * distanceFactor, radius * 2.2, 1e22);
    this.autoRotate = this.autoRotate || 0;
  }

  clearFocus(): void {
    this.followId = -1;
  }

  get focusedId(): number {
    return this.followId;
  }

  /**
   * Follow the focused body. `lookup` returns the current world position and
   * radius of a body id, or null when it no longer exists (destroyed bodies).
   */
  update(dt: number, lookup: (id: number) => CameraTarget | null): void {
    if (this.followId >= 0 && this.followEnabled) {
      const found = lookup(this.followId);
      if (found) {
        this.followPoint.copy(found.position);
        this.focusRadius = Math.max(found.radius, 1);
        // Move the orbit centre with the body; a smoothed offset keeps the
        // camera from jittering when the integrator takes a large sub-step.
        this.target.copy(this.followPoint);
      } else {
        this.followId = -1;
      }
    }
    const smoothing = 1 - Math.exp(-dt * 9);
    this.smoothTarget.lerp(this.target, smoothing);

    if (this.autoRotate !== 0) this.targetAzimuth += this.autoRotate * dt;
    // Keyboard fly-through.
    const speed = this.targetDistance * 2.2 * dt;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.targetDistance *= 1 - 0.6 * dt;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.targetDistance *= 1 + 0.6 * dt;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.targetAzimuth -= dt * 0.9;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.targetAzimuth += dt * 0.9;
    void speed;

    this.distance += (this.targetDistance - this.distance) * smoothing;
    this.azimuth += (this.targetAzimuth - this.azimuth) * smoothing;
    this.elevation += (this.targetElevation - this.elevation) * smoothing;

    const cosEl = Math.cos(this.elevation);
    const offset = new THREE.Vector3(
      Math.sin(this.azimuth) * cosEl,
      Math.sin(this.elevation),
      Math.cos(this.azimuth) * cosEl,
    ).multiplyScalar(this.distance);

    this.camera.position.copy(this.smoothTarget).add(offset);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.smoothTarget);
    this.camera.updateMatrixWorld(true);

    // Adaptive near/far: near tracks the distance to the focus point, far opens
    // up enough to keep the outer system (and the starfield) visible.
    const near = clamp(this.distance * 1e-4, Math.max(this.focusRadius * 1e-3, 0.5), 1e10);
    const far = Math.max(this.distance * 12, this.focusRadius * 200) + 4e13;
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }

    this.camera.getWorldPosition(this.cameraPosition);
    this.viewRotation.copy(this.camera.matrixWorldInverse);
    this.viewRotation.setPosition(0, 0, 0);
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.viewRotation);
  }

  private bindEvents(): void {
    const dom = this.domElement;
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      this.dragging = true;
      this.lastPointerButton = e.button;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.lastPointerButton === 0) {
        this.targetAzimuth -= dx * 0.006;
        this.targetElevation = clamp(this.targetElevation + dy * 0.006, -1.5, 1.5);
      } else {
        // Pan the orbit centre in the camera plane.
        const scale = this.distance * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
        this.followEnabled = false;
      }
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0012);
        this.targetDistance = clamp(this.targetDistance * factor, this.minDistance, this.maxDistance);
      },
      { passive: false },
    );
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  /** Fly to a saved framing (used when a preset loads). */
  setFraming(distance: number, elevation = 0.35, azimuth = 0.6): void {
    this.targetDistance = clamp(distance, 1, 1e24);
    this.targetElevation = elevation;
    this.targetAzimuth = azimuth;
  }
}
