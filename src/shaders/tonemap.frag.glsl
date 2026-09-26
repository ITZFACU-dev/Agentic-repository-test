// Final composite: HDR scene + bloom, exposure from the adaptation buffer,
// ACES filmic tone mapping, then sRGB output and a subtle vignette.
precision highp float;
#include <shared>

varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tAdapt;
uniform float uBloomStrength;
uniform float uExposureBias;
uniform float uVignette;
uniform vec2 uResolution;
uniform float uTime;
uniform float uChromatic;   // 0 = off; 1 = subtle lens dispersion

vec3 sampleHdr(sampler2D tex, vec2 uv) {
  if (uChromatic <= 0.0) return texture2D(tex, uv).rgb;
  vec2 d = (uv - 0.5) * 0.0016 * uChromatic;
  return vec3(
    texture2D(tex, uv + d).r,
    texture2D(tex, uv).g,
    texture2D(tex, uv - d).b
  );
}

void main() {
  vec2 uv = vUv;
  vec3 hdr = sampleHdr(tDiffuse, uv);
  vec3 bloom = sampleHdr(tBloom, uv);
  hdr += bloom * uBloomStrength;

  float adapted = texture2D(tAdapt, vec2(0.5)).r;
  float key = 0.18;
  float exposure = uExposureBias * key / max(exp(adapted), 1e-4);
  vec3 mapped = acesFilm(hdr * exposure);

  // Vignette and a whisper of film grain keep the image from looking flat.
  float r = length((uv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1e-4), 1.0));
  mapped *= mix(1.0, smoothstep(1.15, 0.25, r), uVignette);
  float grain = (hash13(vec3(uv * uResolution, uTime)) - 0.5) * 0.012;
  mapped += grain;

  gl_FragColor = vec4(pow(max(mapped, 0.0), vec3(1.0 / 2.2)), 1.0);
}
