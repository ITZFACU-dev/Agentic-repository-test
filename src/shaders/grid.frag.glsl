// Curvature-grid lines.
//
// The anti-aliasing is analytic: the fragment knows its distance from the camera
// (interpolated from the vertex shader), so the line width is scaled by the
// projected footprint of one grid cell. That avoids fwidth(), which GLSL ES
// 1.00 only provides behind an extension directive that cannot be placed after
// the precision statement three.js injects.
precision highp float;
#include <shared>

varying vec2 vGrid;
varying float vDepth;
varying float vViewDist;

uniform float uGridSize;      // number of cells across the plane
uniform float uSpan;          // plane size in metres
uniform float uOpacity;
uniform vec3 uGridColor;
uniform vec3 uWellColor;
uniform float uTime;

float lineMask(float coord, float width) {
  float f = abs(fract(coord) - 0.5);
  return 1.0 - smoothstep(0.5 - width, 0.5, f);
}

void main() {
  // One grid cell subtends this much of the UV square per screen pixel.
  float cellPixels = (uSpan / max(uGridSize, 1.0)) / max(vViewDist * 0.0016, 1.0);
  float width = clamp(cellPixels, 0.012, 0.42);

  float minor = max(lineMask(vGrid.x * uGridSize, width), lineMask(vGrid.y * uGridSize, width));
  float major = max(lineMask(vGrid.x * 8.0, width * 1.6), lineMask(vGrid.y * 8.0, width * 1.6));

  float depthNorm = clamp(vDepth / max(uSpan * 0.25, 1.0), 0.0, 1.0);
  vec3 color = mix(uGridColor, uWellColor, depthNorm);
  color += uWellColor * pow(depthNorm, 2.0) * 1.2;

  float alpha = (minor * 0.42 + major * 0.58) * uOpacity;
  alpha *= mix(1.0, 0.28, depthNorm);
  // Fade the far edge of the plane so it does not end in a hard line.
  alpha *= 1.0 - smoothstep(0.72, 1.0, max(abs(vGrid.x - 0.5), abs(vGrid.y - 0.5)) * 2.0);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(color * (0.55 + 1.5 * depthNorm), alpha);
}
