/**
 * HDR render pipeline.
 *
 *   scene ─▶ RGBA16F (+depth)                                    ← all drawing
 *            ├─▶ bright pass ─▶ 4 blurred mips ─▶ bloom          ← additive light
 *            ├─▶ luminance ─▶ temporal adaptation (1×1)          ← eye adaptation
 *            └─▶ lensing + relativistic disk ─▶ HDR composite    ← ray-marched post
 *                                              └─▶ ACES tonemap ─▶ canvas
 *
 * Every stage is a hand-written full-screen pass: no post-processing addon, so
 * the lensing pass can read the scene's depth buffer and the bloom mips at the
 * same time as the colour buffer.
 */

import * as THREE from 'three';
import sharedSource from '../shaders/shared.glsl?raw';
import type { QualityProfile } from './Quality';
import fullscreenVert from '../shaders/fullscreen.vert.glsl?raw';
import lensingFrag from '../shaders/lensing.frag.glsl?raw';
import brightFrag from '../shaders/bright.frag.glsl?raw';
import blurFrag from '../shaders/blur.frag.glsl?raw';
import luminanceFrag from '../shaders/luminance.frag.glsl?raw';
import tonemapFrag from '../shaders/tonemap.frag.glsl?raw';

/** Inline `#include <shared>` and substitute integer defines. */
export function glsl(source: string, defines: Record<string, number | string> = {}): string {
  let out = source.replace('#include <shared>', sharedSource);
  for (const [key, value] of Object.entries(defines)) {
    out = out.replace(new RegExp(`\\b${key}\\b`, 'g'), String(value));
  }
  return out;
}

export interface LensUniform {
  position: THREE.Vector3;
  rs: number;
  strength: number;
  axis: THREE.Vector3;
  diskStrength: number;
  diskOuter: number;
  diskTemp: number;
  diskColor: THREE.Color;
}

const MAX_LENSES = 8;
const BLOOM_MIPS = 4;

class FullscreenPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number | string> = {}) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: glsl(fullscreenVert),
      fragmentShader: glsl(fragmentShader, defines),
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
}

export interface PipelineToggles {
  bloom: boolean;
  eyeAdaptation: boolean;
  lensing: boolean;
  chromatic: number;
  bloomStrength: number;
  exposureBias: number;
  vignette: number;
}

export class HDRPipeline {
  readonly renderer: THREE.WebGLRenderer;
  private sceneTarget: THREE.WebGLRenderTarget;
  private bloomTargets: THREE.WebGLRenderTarget[] = [];
  private blurScratch: THREE.WebGLRenderTarget[] = [];
  private bloomComposite: THREE.WebGLRenderTarget;
  private lumTarget: THREE.WebGLRenderTarget;
  private adaptTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private lensTarget: THREE.WebGLRenderTarget;
  private width = 0;
  private height = 0;
  private adaptFlip = 0;
  private time = 0;

  toggles: PipelineToggles = {
    bloom: true,
    eyeAdaptation: true,
    lensing: true,
    chromatic: 0.5,
    bloomStrength: 0.55,
    exposureBias: 1.15,
    vignette: 0.75,
  };

  lensCount = 0;
  lensStrengthScale = 1;

  private brightPass: FullscreenPass;
  private blurPass: FullscreenPass;
  private lumPass: FullscreenPass;
  private lensPass: FullscreenPass;
  private tonemapPass: FullscreenPass;

  /** Bloom mip levels actually used (the rest are skipped for speed). */
  private bloomMipCount = BLOOM_MIPS;
  private pixelRatioCap = 1.5;

  constructor(canvas: HTMLCanvasElement, antialias = true) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioCap));
    // Tone mapping and colour conversion happen in the tonemap pass, in linear
    // HDR space, so three must not touch either of them.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = true;

    const make = (w: number, h: number, depth: boolean) => {
      const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: depth,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return rt;
    };

    this.sceneTarget = make(2, 2, true);
    this.sceneTarget.depthTexture = new THREE.DepthTexture(2, 2, THREE.UnsignedIntType);
    this.bloomComposite = make(2, 2, false);
    this.lumTarget = make(16, 16, false);
    this.adaptTargets = [make(1, 1, false), make(1, 1, false)];
    this.lensTarget = make(2, 2, false);
    for (let i = 0; i < BLOOM_MIPS; i++) {
      this.bloomTargets.push(make(2, 2, false));
      this.blurScratch.push(make(2, 2, false));
    }

    this.brightPass = new FullscreenPass(brightFrag, {
      tDiffuse: { value: null },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.6 },
      uExposure: { value: 1 },
    });
    this.blurPass = new FullscreenPass(blurFrag, {
      tDiffuse: { value: null },
      uDirection: { value: new THREE.Vector2(1, 0) },
      uRadius: { value: 1 },
    });
    this.lumPass = new FullscreenPass(luminanceFrag, {
      tDiffuse: { value: null },
      tPrevious: { value: null },
      uRate: { value: 1.6 },
      uMinLogLum: { value: -6 },
      uMaxLogLum: { value: 12 },
      uDt: { value: 1 / 60 },
    });
    this.lensPass = new FullscreenPass(
      lensingFrag,
      {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uInverseProjection: { value: new THREE.Matrix4() },
        uProjection: { value: new THREE.Matrix4() },
        uCameraMatrix: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uNear: { value: 1 },
        uFar: { value: 1e9 },
        uLensCount: { value: 0 },
        uLensPos: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Vector3()) },
        uLensRs: { value: new Float32Array(MAX_LENSES) },
        uLensStrength: { value: new Float32Array(MAX_LENSES) },
        uLensAxis: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Vector3(0, 1, 0)) },
        uDiskStrength: { value: new Float32Array(MAX_LENSES) },
        uDiskOuter: { value: new Float32Array(MAX_LENSES) },
        uDiskTemp: { value: new Float32Array(MAX_LENSES) },
        uDiskColor: { value: Array.from({ length: MAX_LENSES }, () => new THREE.Color(1, 1, 1)) },
        uSteps: { value: 6 },
        uEnabled: { value: 1 },
      },
      { MAX_LENSES },
    );
    // Prime the adaptation buffers with a mid-grey log-luminance so the first
    // frame is not exposed from uninitialised memory.
    this.tonemapPass = new FullscreenPass(tonemapFrag, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      tAdapt: { value: null },
      uBloomStrength: { value: 0.55 },
      uExposureBias: { value: 1.15 },
      uVignette: { value: 0.75 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uChromatic: { value: 0.5 },
    });

    for (const rt of this.adaptTargets) {
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
  }

  get renderTarget(): THREE.WebGLRenderTarget {
    return this.sceneTarget;
  }

  /**
   * Apply a quality profile. Pixel ratio is the dominant cost — a HiDPI screen
   * at ratio 2 costs four times the fill rate of ratio 1 — so it moves first,
   * then the sample counts the shaders read.
   */
  applyQuality(profile: QualityProfile): void {
    this.pixelRatioCap = profile.pixelRatio;
    this.bloomMipCount = Math.max(1, Math.min(BLOOM_MIPS, profile.bloomMips));
    this.toggles.chromatic = profile.chromatic;
    const ratio = Math.min(window.devicePixelRatio || 1, profile.pixelRatio) * profile.renderScale;
    this.renderer.setPixelRatio(ratio);
    // Force a resize even if the CSS size has not changed.
    const w = this.width;
    const h = this.height;
    this.width = 0;
    this.height = 0;
    this.setSize(w, h);
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    this.renderer.setSize(width, height, false);
    this.sceneTarget.setSize(w, h);
    // A resized depth texture must be re-uploaded with its new dimensions.
    const depth = this.sceneTarget.depthTexture;
    if (depth) {
      depth.image = { width: w, height: h, depth: 1 } as typeof depth.image;
      depth.needsUpdate = true;
    }
    this.lensTarget.setSize(w, h);
    this.bloomComposite.setSize(Math.floor(w / 4), Math.floor(h / 4));
    this.lumTarget.setSize(Math.max(4, Math.floor(w / 16)), Math.max(4, Math.floor(h / 16)));
    for (let i = 0; i < BLOOM_MIPS; i++) {
      const s = Math.max(2, Math.floor(w / (4 << i)));
      this.bloomTargets[i].setSize(s, Math.max(2, Math.floor(h / (4 << i))));
      this.blurScratch[i].setSize(s, Math.max(2, Math.floor(h / (4 << i))));
    }
  }

  /** Hand the compact objects to the lensing pass. */
  setLenses(lenses: LensUniform[]): void {
    const u = this.lensPass.material.uniforms;
    const n = Math.min(lenses.length, MAX_LENSES);
    this.lensCount = n;
    for (let i = 0; i < n; i++) {
      const l = lenses[i];
      (u.uLensPos.value as THREE.Vector3[])[i].copy(l.position);
      (u.uLensRs.value as Float32Array)[i] = Math.max(l.rs, 0);
      (u.uLensStrength.value as Float32Array)[i] = l.strength * this.lensStrengthScale;
      (u.uLensAxis.value as THREE.Vector3[])[i].copy(l.axis);
      (u.uDiskStrength.value as Float32Array)[i] = l.diskStrength;
      (u.uDiskOuter.value as Float32Array)[i] = l.diskOuter;
      (u.uDiskTemp.value as Float32Array)[i] = l.diskTemp;
      (u.uDiskColor.value as THREE.Color[])[i].copy(l.diskColor);
    }
    u.uLensCount.value = n;
  }

  private draw(pass: FullscreenPass, target: THREE.WebGLRenderTarget | null): void {
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(pass.scene, pass.camera);
  }

  /**
   * Render the scene into the HDR buffer. The caller then calls `composite()`.
   * Splitting the two lets the app draw overlays between the scene and the
   * lensing pass (trails, arrows and labels must not be lensed).
   */
  renderScene(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    this.time += dt;
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);

    const u = this.lensPass.material.uniforms;
    u.tDiffuse.value = this.sceneTarget.texture;
    u.tDepth.value = this.sceneTarget.depthTexture;
    u.uResolution.value.set(this.width, this.height);
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    u.uProjection.value.copy(camera.projectionMatrix);
    u.uCameraMatrix.value.copy(camera.matrixWorldInverse);
    camera.getWorldPosition(u.uCameraPosition.value as THREE.Vector3);
    u.uNear.value = (camera as THREE.PerspectiveCamera).near;
    u.uFar.value = (camera as THREE.PerspectiveCamera).far;
    u.uEnabled.value = this.toggles.lensing ? 1 : 0;
  }

  /** Bloom, eye adaptation, lensing and tone mapping, in that order. */
  composite(): void {
    const t = this.toggles;
    // 1. Bright pass into mip 0.
    this.brightPass.material.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.brightPass.material.uniforms.uExposure.value = t.exposureBias;
    this.draw(this.brightPass, this.bloomTargets[0]);

    // 2. Blur and downsample the mip chain (only the levels the tier allows).
    const mips = this.bloomMipCount;
    for (let i = 0; i < mips; i++) {
      const src = this.bloomTargets[i];
      const scratch = this.blurScratch[i];
      const w = src.width;
      const h = src.height;
      this.blurPass.material.uniforms.tDiffuse.value = src.texture;
      this.blurPass.material.uniforms.uDirection.value.set(1 / w, 0);
      this.blurPass.material.uniforms.uRadius.value = 1 + i * 0.75;
      this.draw(this.blurPass, scratch);
      this.blurPass.material.uniforms.tDiffuse.value = scratch.texture;
      this.blurPass.material.uniforms.uDirection.value.set(0, 1 / h);
      this.draw(this.blurPass, src);
      if (i + 1 < mips) {
        // Downsample by blitting with a linear filter.
        this.blurPass.material.uniforms.tDiffuse.value = src.texture;
        this.blurPass.material.uniforms.uDirection.value.set(1 / w, 0);
        this.blurPass.material.uniforms.uRadius.value = 0;
        this.draw(this.blurPass, this.bloomTargets[i + 1]);
      }
    }

    // 3. Eye adaptation: log-luminance of a 1/16 buffer, temporally smoothed.
    if (t.eyeAdaptation) {
      this.lumPass.material.uniforms.tDiffuse.value = this.lumTarget.texture;
      this.lumPass.material.uniforms.tPrevious.value = this.adaptTargets[this.adaptFlip].texture;
      this.lumPass.material.uniforms.uDt.value = 1 / 60;
      const next = 1 - this.adaptFlip;
      this.draw(this.lumPass, this.adaptTargets[next]);
      this.adaptFlip = next;
      // Keep the 1/16 luminance buffer current for the next frame.
      this.blurPass.material.uniforms.tDiffuse.value = this.sceneTarget.texture;
      this.blurPass.material.uniforms.uDirection.value.set(1 / this.lumTarget.width, 0);
      this.blurPass.material.uniforms.uRadius.value = 0;
      this.draw(this.blurPass, this.lumTarget);
    } else {
      this.lumPass.material.uniforms.tDiffuse.value = this.sceneTarget.texture;
      this.lumPass.material.uniforms.tPrevious.value = this.adaptTargets[this.adaptFlip].texture;
      const next = 1 - this.adaptFlip;
      this.lumPass.material.uniforms.uRate.value = 200;
      this.draw(this.lumPass, this.adaptTargets[next]);
      this.adaptFlip = next;
      this.lumPass.material.uniforms.uRate.value = 1.6;
    }

    // 4. Lensing + relativistic disk (skipped entirely when switched off).
    if (t.lensing) this.draw(this.lensPass, this.lensTarget);

    // 5. Tonemap to the canvas.
    const tonemap = this.tonemapPass.material.uniforms;
    tonemap.tDiffuse.value = (t.lensing ? this.lensTarget : this.sceneTarget).texture;
    tonemap.tBloom.value = this.bloomTargets[0].texture;
    tonemap.tAdapt.value = this.adaptTargets[this.adaptFlip].texture;
    tonemap.uBloomStrength.value = t.bloom ? t.bloomStrength : 0;
    tonemap.uExposureBias.value = t.exposureBias;
    tonemap.uVignette.value = t.vignette;
    tonemap.uChromatic.value = t.chromatic;
    tonemap.uResolution.value.set(this.width, this.height);
    tonemap.uTime.value = this.time;
    this.draw(this.tonemapPass, null);
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.lensTarget.dispose();
    this.bloomComposite.dispose();
    this.lumTarget.dispose();
    for (const r of this.bloomTargets) r.dispose();
    for (const r of this.blurScratch) r.dispose();
    for (const r of this.adaptTargets) r.dispose();
    this.renderer.dispose();
  }
}

export { MAX_LENSES, BLOOM_MIPS };
