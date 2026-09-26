/**
 * GLSL ES 1.00 syntax + symbol check for every shader in src/shaders.
 *
 * Catches the mistakes a GPU would only report at run time (and only in a
 * browser console): unbalanced braces, bad constructor arity, array
 * constructors that ES 1.00 does not have, and — the one that actually bit us —
 * calling a helper from shared.glsl in a shader that forgot
 * `#include <shared>`, which fails at link time with a useless message:
 *     ERROR: 0:80: 'luma' : no matching overloaded function found
 *
 * The `#include <shared>` directive is resolved here exactly as
 * src/render/HDRPipeline.ts resolves it.
 */
import { parser } from '@shaderfrog/glsl-parser';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/shaders', import.meta.url);
const sharedSource = readFileSync(new URL('../src/shaders/shared.glsl', import.meta.url), 'utf8');

// Every symbol defined in shared.glsl that a shader may call.
const SHARED_SYMBOLS = [
  'hash11', 'hash13', 'hash33', 'noise3', 'fbm', 'ridged', 'warpedFbm',
  'blackbody', 'acesFilm', 'luma', 'rotateAbout', 'OCT_ROT',
];

const files = readdirSync(dir).filter((f) => f.endsWith('.glsl'));
let failures = 0;
const fail = (file, message) => {
  failures++;
  console.log(`  FAIL  ${file}: ${message}`);
};

for (const file of files) {
  const raw = readFileSync(new URL(`../src/shaders/${file}`, import.meta.url), 'utf8');
  const hasInclude = raw.includes('#include <shared>');
  // Scan code, not prose: a comment that mentions fwidth must not fail the build.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // 1. A shader that calls into shared.glsl must include it.
  if (file !== 'shared.glsl' && !hasInclude) {
    const used = SHARED_SYMBOLS.filter((s) => new RegExp(`(?<![\\w.])${s}\\b`).test(code));
    if (used.length > 0) fail(file, `uses ${used.join(', ')} from shared.glsl but has no \`#include <shared>\``);
  }

  // 2. It must parse, both standalone and with the include inlined.
  const variants = [['standalone', raw]];
  if (hasInclude) variants.push(['inlined', raw.replace('#include <shared>', sharedSource)]);
  for (const [kind, source] of variants) {
    const text = source.replace(/\bMAX_LENSES\b/g, '16');
    try {
      parser.parse(text);
    } catch (e) {
      fail(file, `${kind}: ${String(e.message).split('\n')[0]}`);
    }
  }

  // 3. No array constructors (ES 1.00 has none) and no fwidth/dFdx without the
  //    extension directive that three.js cannot place for us.
  if (/\bfloat\[\]\s*\(/.test(code)) fail(file, 'array constructor float[](...) is not GLSL ES 1.00');
  if (/\b(fwidth|dFdx|dFdy)\s*\(/.test(code) && !/GL_OES_standard_derivatives/.test(code)) {
    fail(file, 'uses derivatives without enabling GL_OES_standard_derivatives');
  }
}

const checked = files.length;
console.log(failures === 0 ? `ALL ${checked} SHADERS OK` : `${failures} SHADER FAILURES`);
process.exit(failures === 0 ? 0 : 1);
