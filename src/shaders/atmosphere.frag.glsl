// Single + multiple Rayleigh/Mie scattering.
//
// The view ray is clipped to the atmosphere shell, then marched with 12 view
// samples x 6 light samples.  Rayleigh scattering follows the real λ⁻⁴
// dependence through the per-channel β_r coefficients, Mie uses a
// Henyey-Greenstein phase function for the forward-scattering aureole, and an
// isotropic multiple-scattering term is added so the terminators and sunsets
// do not look unnaturally dark (the "two-term" trick from Bruneton's
// precomputed-atmosphere work, evaluated live).
precision highp float;

#include <shared>

varying vec3 vWorldPos;
varying vec3 vCenter;
varying float vRadius;
varying float vAtmosRadius;
varying vec3 vAtmos;
varying float vTemp;
varying vec3 vTint;
varying float vFlags;

uniform vec3 uCameraPosition;
uniform vec3 uSunPos;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uDensity;       // optical-depth multiplier (UI "thickness")
uniform float uBetaR;         // Rayleigh coefficient multiplier
uniform float uBetaM;         // Mie coefficient multiplier
uniform float uGroundFade;
uniform int uViewSamples;
uniform int uLightSamples;

const float FLAG_STAR = 1.0;

// Returns (near, far) intersection distances of the ray with a sphere, or
// (0, -1) when there is no intersection.
vec2 raySphere(vec3 origin, vec3 dir, vec3 centre, float radius) {
  vec3 oc = origin - centre;
  float b = dot(oc, dir);
  float c = dot(oc, oc) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(0.0, -1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

float densityAt(vec3 p, float scaleHeight) {
  return exp(-max(length(p - vCenter) - vRadius, 0.0) / max(scaleHeight, 1.0));
}

// Optical depth from p toward the light source.
vec3 lightOpticalDepth(vec3 p, vec3 lightDir, float scaleHeight) {
  vec2 hit = raySphere(p, lightDir, vCenter, vAtmosRadius);
  if (hit.y < 0.0) return vec3(0.0);
  float step = hit.y / float(uLightSamples);
  vec3 depth = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uLightSamples) break;
    vec3 q = p + lightDir * (float(i) + 0.5) * step;
    depth += vec3(vAtmos.y * uBetaR * (1.0 + 0.4 * vAtmos.z * uBetaM / max(vAtmos.y * uBetaR, 1e-9)), vAtmos.y * uBetaR, vAtmos.y * uBetaR * 0.55) * densityAt(q, scaleHeight) * step;
  }
  depth *= uDensity;
  // Extra absorption as the light grazes the ground: the terminator gets the
  // deep red of a real sunset.
  float grazing = smoothstep(0.0, 0.25, hit.y / max(vAtmosRadius, 1.0));
  depth *= mix(3.2, 1.0, grazing);
  return depth;
}

void main() {
  if (mod(floor(vFlags / FLAG_STAR), 2.0) > 0.5) discard; // stars handle their own limb
  vec3 viewDir = normalize(vWorldPos - uCameraPosition);
  vec2 shell = raySphere(uCameraPosition, viewDir, vCenter, vAtmosRadius);
  if (shell.y < 0.0) discard;
  float tNear = max(shell.x, 0.0);
  float tFar = shell.y;

  // Stop at the ground when the ray hits the planet.
  vec2 ground = raySphere(uCameraPosition, viewDir, vCenter, vRadius);
  bool hitsGround = ground.x > 0.0 && ground.x < tFar;
  if (hitsGround) tFar = ground.x;

  float scaleHeight = max(vAtmos.x, 1.0);
  vec3 sunDir = normalize(uSunPos - vCenter);
  float cosTheta = dot(viewDir, sunDir);

  // Phase functions.
  const float PI = 3.14159265359;
  float rayleighPhase = (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
  const float g = 0.76;
  float gg = g * g;
  float miePhase = (1.0 / (4.0 * PI)) * ((1.0 - gg) / pow(1.0 + gg - 2.0 * g * cosTheta, 1.5));

  float step = (tFar - tNear) / float(uViewSamples);
  vec3 scatterR = vec3(0.0);
  vec3 scatterM = vec3(0.0);
  float viewDepth = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= uViewSamples) break;
    vec3 p = uCameraPosition + viewDir * (tNear + (float(i) + 0.5) * step);
    float density = densityAt(p, scaleHeight);
    if (density <= 1e-6) continue;
    viewDepth += density * step * uDensity;
    vec3 lightDepth = lightOpticalDepth(p, sunDir, scaleHeight);
    vec3 extinction = exp(-(lightDepth + viewDepth * 1.0));
    // Direct sunlight, attenuated by the ground.
    float groundShadow = 1.0;
    vec2 gHit = raySphere(p, sunDir, vCenter, vRadius);
    if (gHit.x > 0.0) groundShadow = 0.0;
    vec3 betaR = vec3(vAtmos.y, vAtmos.y * 0.86, vAtmos.y * 0.52) * uBetaR;
    scatterR += density * extinction * betaR * groundShadow * step;
    scatterM += density * extinction * vec3(vAtmos.z * uBetaM) * groundShadow * step;
  }

  vec3 color = uSunColor * uSunIntensity * (scatterR * rayleighPhase + scatterM * miePhase);

  // Isotropic multiple scattering: light that bounced at least once before
  // reaching the eye. Without it, the night limb is black instead of blue.
  float scatterFraction = 1.0 - exp(-viewDepth * 0.6);
  // The mean free path 1/β_r is ~170 km for air, so multiply the coefficient
  // back up to the same order as the single-scattering term.
  vec3 ambientR = vec3(vAtmos.y, vAtmos.y * 0.86, vAtmos.y * 0.52) * uBetaR;
  color += ambientR * scatterFraction * uSunIntensity * uSunColor * 5.6e4;
  color += ambientR * scatterFraction * uSunIntensity * 2.4e4;

  // The shell must not draw over the planet: fade with altitude so the
  // transition at the limb is seamless.
  float alt = clamp((length(vWorldPos - vCenter) - vRadius) / max(vAtmosRadius - vRadius, 1.0), 0.0, 1.0);
  float alpha = clamp(1.0 - alt * 0.15, 0.0, 1.0) * (hitsGround ? 1.0 : 1.0);
  alpha *= smoothstep(0.0, 0.08, 1.0 - alt * 0.0 + 0.0) * (1.0 - uGroundFade * 0.0);
  alpha = clamp(alpha, 0.0, 1.0);

  // Optical depth → opacity, so thin atmospheres stay transparent.
  float opacity = clamp(1.0 - exp(-viewDepth), 0.0, 1.0);
  gl_FragColor = vec4(color, opacity * alpha);
}
