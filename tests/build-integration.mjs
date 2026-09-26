/**
 * Bundles tests/integration.spec.ts for Node.
 *
 * The harness imports the real renderer modules, which import their GLSL
 * through Vite's `?raw` suffix — esbuild has no such loader, so this plugin
 * resolves `*.glsl?raw` to the file and inlines it as text. That is the only
 * difference between what the browser loads and what the harness loads.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

await build({
  entryPoints: [path.join(here, 'integration.spec.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(root, '.tmp/integration.mjs'),
  logLevel: 'error',
  plugins: [
    {
      name: 'raw-glsl',
      setup(b) {
        b.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
          namespace: 'raw',
        }));
        b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
          contents: fs.readFileSync(args.path, 'utf8'),
          loader: 'text',
        }));
      },
    },
  ],
});
