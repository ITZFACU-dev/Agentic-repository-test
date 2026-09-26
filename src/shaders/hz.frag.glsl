// Volumetric-looking habitable-zone ribbons.
//
// The inner/outer edges scale with √L (the inverse-square law: the same flux
// arrives at r ∝ √L), and the two bands are the classic Kopparapu-style
// conservative (runaway greenhouse → maximum greenhouse) and optimistic
// (recent-Venus → early-Mars) limits.
precision highp float;
#include <shared>

varying vec2 vLocal;
varying vec3 vColor;
varying float vMode;
varying float vRadial;

uniform float uTime;
uniform float uOpacity;

void main() {
  // RingGeometry's uv is the *planar* position inside the ring's bounding
  // square, so the radius fraction is 2·|uv − ½| mapped onto [0.7, 1.0].
  float radial = length(vLocal - 0.5) * 2.0;
  float band = clamp((radial - 0.7) / 0.3, 0.0, 1.0);
  float edge = smoothstep(0.0, 0.12, band) * smoothstep(1.0, 0.88, band);
  // Depth haze: the ribbon is denser toward the middle of the band.
  float body = 0.35 + 0.65 * sin(band * 3.14159);
  // A slow flowing texture makes it read as a volume rather than a decal.
  float flow = 0.75 + 0.25 * sin(band * 26.0 - uTime * 0.7 + vLocal.x * 12.0);
  vec3 color = vColor * (1.0 + 0.5 * (1.0 - vMode));
  float alpha = edge * body * flow * uOpacity * (vMode > 0.5 ? 0.35 : 0.55);
  gl_FragColor = vec4(color * (0.9 + 0.6 * body), alpha);
}
