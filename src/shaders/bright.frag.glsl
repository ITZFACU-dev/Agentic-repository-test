// Bright-pass with a soft knee — the first stage of the HDR bloom chain.
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
uniform float uExposure;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
  float l = max(max(c.r, c.g), c.b);
  float knee = max(uKnee, 1e-4);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * contribution, 1.0);
}
