import { defineConfig } from 'vite';

// Cosmoscope build configuration.
// The physics core is a module worker; shaders are imported as GLSL strings
// through `?raw` so they can be authored in real .glsl files with tooling support.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The Arena sandbox proxies the dev server through a per-port hostname
    // (https://<port>-<sandbox>.e2b.app); allow any host so the live preview works.
    allowedHosts: true,
    headers: {
      // Required for SharedArrayBuffer / multi-threaded workers if ever enabled.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
  },
});
