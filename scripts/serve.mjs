#!/usr/bin/env node
/**
 * Zero-dependency static server for the built Cosmoscope bundle.
 *
 * The app is a WebGL2 page with an ES-module worker, so it has to be served over
 * HTTP rather than opened from the file system (browsers refuse module workers
 * on `file://`). This is the smallest thing that does that:
 *
 *     node serve.mjs            # http://localhost:8080
 *     node serve.mjs 3000       # pick a port
 *
 * Node 18+ required. Nothing is written to disk and nothing leaves the machine.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Find the bundle. In the repository this script lives in `scripts/` and the
 * build is in `dist/`; in the released zip it sits right next to `index.html`.
 */
async function findRoot() {
  const candidates = [resolve(here, 'dist'), resolve(here, '..', 'dist'), resolve(here)];
  for (const candidate of candidates) {
    const info = await stat(join(candidate, 'index.html')).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  console.error('No index.html found next to serve.mjs or in ./dist — run `npm run build` first.');
  process.exit(1);
}

const root = await findRoot();
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);

    // Never serve anything outside dist/.
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(file).catch(() => null);
    const target = info?.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);

    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // Matches the Vite dev server, in case cross-origin isolation is ever used.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Cosmoscope is running at http://localhost:${port}`);
  console.log('Press Ctrl+C to stop.');
});
