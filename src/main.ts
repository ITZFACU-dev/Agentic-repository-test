/**
 * Cosmoscope — entry point.
 *
 * Boots the WebGL2 renderer, the physics worker and the instrument-panel UI,
 * then hands control to the App's frame loop.
 */

import './ui/styles.css';
import { App } from './ui/App';

const root = document.getElementById('app');
if (!root) throw new Error('#app container missing');

/**
 * Anything that goes wrong inside the render loop — a shader that will not
 * compile, a driver that refuses a half-float render target — must be visible
 * rather than a black screen, so every failure path funnels into this banner.
 */
function fatal(title: string, detail: string): void {
  const existing = document.getElementById('fatal');
  const banner = existing ?? document.createElement('div');
  banner.id = 'fatal';
  banner.style.cssText = `
    position:fixed;left:50%;transform:translateX(-50%);top:74px;z-index:99;max-width:min(760px,92vw);
    background:rgba(60,12,14,.94);border:1px solid rgba(255,106,92,.55);border-radius:10px;
    padding:12px 16px;font:12px/1.5 ui-monospace,monospace;color:#ffd9d4;white-space:pre-wrap;
    box-shadow:0 12px 40px rgba(0,0,0,.6)`;
  banner.textContent = `${title}\n${detail}`;
  if (!existing) document.body.appendChild(banner);
}
window.addEventListener('error', (e) => fatal('Runtime error', `${e.message}\n${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) => fatal('Unhandled promise rejection', String(e.reason)));

// three.js reports shader compilation problems through console.error; surface
// them too, since they are otherwise invisible behind a black canvas.
const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  originalError(...args);
  const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : '')).join(' ');
  if (/shader|GLSL|WebGL|program/i.test(text) && text.length > 12) {
    fatal('Shader / GPU problem', text.slice(0, 1400));
  }
};

// WebGL2 is mandatory: the pipeline uses floating-point render targets,
// instanced drawing with per-instance attributes and a depth texture.
const probe = document.createElement('canvas');
const gl = probe.getContext('webgl2');
if (!gl) {
  root.innerHTML = `
    <div style="display:grid;place-items:center;height:100%;text-align:center;padding:40px">
      <div>
        <h1 style="letter-spacing:.2em;text-transform:uppercase;color:#5cc8ff">WebGL2 required</h1>
        <p style="color:#8b9ab5;max-width:520px;line-height:1.6">
          Cosmoscope renders HDR floating-point buffers, instanced procedural surfaces and
          ray-marched gravitational-lensing passes, all of which need WebGL2.
          Please enable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.
        </p>
      </div>
    </div>`;
  document.getElementById('loading')?.remove();
} else {
  const app = new App(root);
  // Handy for the console: poke at the live simulation while it runs.
  (window as unknown as { cosmoscope: App }).cosmoscope = app;
}
