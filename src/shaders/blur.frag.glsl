// Separable Gaussian blur (9 taps, linear-filtered). Called twice per mip with
// uDirection set to that mip's horizontal and then vertical axis.
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDirection;   // UV step of one texel along the blur axis
uniform float uRadius;     // blur radius in texels (grows with the mip level)

void main() {
  float w0 = 0.2270270270;
  float w1 = 0.3162162162;
  float w2 = 0.0702702703;
  float w3 = 0.0062162162;
  float w4 = 0.0004567568;
  float o1 = 1.3846153846;
  float o2 = 3.2307692308;
  float o3 = 5.0769230769;
  float o4 = 6.9230769231;

  // The offsets are in texels, and uDirection is one texel wide, so the taps
  // land at ±1.4, ±3.2, ±5.1 and ±6.9 texels — a 14-texel-wide kernel that
  // widens with the mip level.
  vec2 step1 = uDirection * o1 * uRadius;
  vec2 step2 = uDirection * o2 * uRadius;
  vec2 step3 = uDirection * o3 * uRadius;
  vec2 step4 = uDirection * o4 * uRadius;

  vec3 sum = texture2D(tDiffuse, vUv).rgb * w0;
  sum += (texture2D(tDiffuse, vUv + step1).rgb + texture2D(tDiffuse, vUv - step1).rgb) * w1;
  sum += (texture2D(tDiffuse, vUv + step2).rgb + texture2D(tDiffuse, vUv - step2).rgb) * w2;
  sum += (texture2D(tDiffuse, vUv + step3).rgb + texture2D(tDiffuse, vUv - step3).rgb) * w3;
  sum += (texture2D(tDiffuse, vUv + step4).rgb + texture2D(tDiffuse, vUv - step4).rgb) * w4;
  gl_FragColor = vec4(sum, 1.0);
}
