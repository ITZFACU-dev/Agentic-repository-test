precision highp float;
#include <shared>

varying vec2 vUv;
varying float vTemp;

uniform vec3 uSunPos;
uniform float uSunIntensity;
uniform vec3 uTint;

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // Soft-edged sphere sprite with a bright core.
  float alpha = smoothstep(0.25, 0.02, r2);
  vec3 body = blackbody(clamp(vTemp, 400.0, 4000.0)) * (vTemp > 900.0 ? 2.4 : 1.0);
  vec3 c = mix(uTint * 0.55, body, vTemp > 900.0 ? 1.0 : 0.25);
  c *= 0.4 + 0.6 * uSunIntensity;
  gl_FragColor = vec4(c, alpha * 0.95);
}
