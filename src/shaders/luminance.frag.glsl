// 1×1 log-average luminance, with temporal adaptation.
//
// Eye adaptation is what lets the renderer show a sunlit planet and a distant
// nebula in the same frame: the exposure chases the average scene luminance
// slowly (dark-adapt in ~2 s, bright-adapt in ~0.4 s, like a real retina).
precision highp float;
#include <shared>

varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tPrevious;
uniform float uRate;
uniform float uMinLogLum;
uniform float uMaxLogLum;
uniform float uDt;

void main() {
  // Average the (already downsampled) source.
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / 4.0;
      sum += texture2D(tDiffuse, uv).rgb;
    }
  }
  float lum = luma(sum / 16.0);
  float logLum = clamp(log(max(lum, 1e-6)), uMinLogLum, uMaxLogLum);
  float previous = texture2D(tPrevious, vec2(0.5)).r;
  // Asymmetric adaptation: eyes dark-adapt slowly and bright-adapt quickly.
  float speed = logLum > previous ? uRate * 4.0 : uRate;
  float adapted = mix(previous, logLum, clamp(uDt * speed, 0.0, 1.0));
  gl_FragColor = vec4(adapted, 0.0, 0.0, 1.0);
}
