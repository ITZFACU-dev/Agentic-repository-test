/**
 * GLSL ES 1.00 syntax check for every shader in src/shaders.
 *
 * Catches the mistakes a GPU would only report at run time (and only in a
 * browser console): unbalanced braces, bad constructor arity, array
 * constructors that ES 1.00 does not have, and so on. The `#include <shared>`
 * directive is resolved here exactly as the renderer resolves it.
 */
import { parser } from '@shaderfrog/glsl-parser';
import { readFileSync, readdirSync } from 'node:fs';

const shared = readFileSync(new URL('../src/shaders/shared.glsl', import.meta.url), 'utf8');
let bad = 0;
for (const f of readdirSync(new URL('../src/shaders', import.meta.url)).filter((f) => f.endsWith('.glsl'))) {
  let src = readFileSync(new URL(`../src/shaders/${f}`, import.meta.url), 'utf8');
  // Strip include for the linter (it is inlined later), substitute MAX_LENSES.
  src = src.replace('#include <shared>', '');
  src = src.replace(/\bMAX_LENSES\b/g, '16');
  try {
    parser.parse(src);
    console.log(`  ok    ${f}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL  ${f}: ${String(e.message).split('\n').slice(0, 4).join(' | ')}`);
  }
}
// Also verify the include-inlined versions parse.
for (const f of readdirSync(new URL('../src/shaders', import.meta.url)).filter((f) => f.endsWith('.glsl'))) {
  let src = readFileSync(new URL(`../src/shaders/${f}`, import.meta.url), 'utf8');
  if (!src.includes('#include <shared>')) continue;
  src = src.replace('#include <shared>', shared).replace(/\bMAX_LENSES\b/g, '16');
  try { parser.parse(src); } catch (e) { bad++; console.log(`  FAIL  ${f} (inlined): ${String(e.message).split('\n')[0]}`); }
}
console.log(bad === 0 ? 'ALL SHADERS PARSE' : `${bad} FAILURES`);
process.exit(bad === 0 ? 0 : 1);
