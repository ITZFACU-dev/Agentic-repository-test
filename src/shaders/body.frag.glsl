// Procedural body surfaces: continents, oceans, ice caps, gas-giant banding,
// lava after an impact, stellar granulation and limb darkening.
// Everything is generated from the instance seed, so a body keeps its identity
// across frames and across sessions without any texture upload.
precision highp float;

#include <shared>

varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec3 vLocalDir;
varying vec3 vTint;
varying float vTemp;
varying float vFlags;
varying float vSeed;
varying float vRadius;
varying vec3 vSpherePos;

uniform vec3 uSunPos;      // primary light (the dominant luminous body)
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform vec3 uCameraPosition;
uniform float uTime;
uniform float uLavaThreshold;
uniform float uSurfaceDetail;   // 0 = cheap, 1 = full octave count

// BodyFlags must match src/sim/protocol.ts
const float FLAG_STAR = 1.0;
const float FLAG_BLACKHOLE = 2.0;
const float FLAG_ATMOSPHERE = 4.0;
const float FLAG_ROCKY = 8.0;
const float FLAG_GAS = 16.0;
const float FLAG_FROZEN = 32.0;
const float FLAG_TRACER = 64.0;
const float FLAG_GLOWING = 128.0;

float flag(float f) { return mod(floor(vFlags / f), 2.0); }

/** Rocky/icy terrain in linear sRGB. */
vec3 rockySurface(vec3 dir, out float height, out float water) {
  vec3 p = dir * 2.6 + vec3(vSeed * 13.7);
  int oct = uSurfaceDetail > 0.5 ? 7 : 4;
  float continents = warpedFbm(p * 0.85, oct, 0.55);
  float mountains = ridged(p * 4.2, oct - 1, 2.1, 0.52);
  height = continents * 0.75 + mountains * 0.28;
  // Water fills everything below sea level.
  float seaLevel = mix(0.02, -0.16, clamp(vTint.b - vTint.r + 0.5, 0.0, 1.0));
  water = smoothstep(seaLevel, seaLevel + 0.015, height);
  vec3 rock = mix(vec3(0.18, 0.15, 0.12), vec3(0.42, 0.36, 0.29), smoothstep(-0.2, 0.5, height));
  rock = mix(rock, vec3(0.55, 0.33, 0.18), smoothstep(0.35, 0.75, height) * 0.7); // highlands
  vec3 ocean = mix(vec3(0.015, 0.06, 0.13), vec3(0.03, 0.16, 0.30), vTint.b);
  vec3 c = mix(ocean, rock, water);
  // Latitudinal ice: polar caps grow as the body gets colder.
  float lat = abs(dir.y);
  float iceLine = mix(0.92, 0.35, clamp((200.0 - vTemp) / 160.0, 0.0, 1.0));
  float ice = smoothstep(iceLine, iceLine + 0.12, lat + height * 0.25);
  c = mix(c, vec3(0.86, 0.9, 0.95), ice * 0.85);
  return c;
}

/** Banded gas giant with turbulent shear. */
vec3 gasSurface(vec3 dir) {
  float lat = dir.y;
  float bands = sin(lat * 16.0 + fbm(dir * 3.0 + vSeed, 4, 2.0, 0.5) * 3.4);
  float turbulence = fbm(dir * vec3(6.0, 14.0, 6.0) + vSeed * 3.1, 5, 2.05, 0.55);
  float shade = bands * 0.5 + 0.5;
  vec3 warm = vTint * 1.15;
  vec3 cool = vTint * 0.55;
  vec3 c = mix(cool, warm, shade);
  c *= 0.85 + 0.3 * turbulence;
  // Great-spot style vortex.
  vec3 spotDir = normalize(vec3(sin(vSeed * 2.1), 0.32, cos(vSeed * 2.1)));
  float spot = smoothstep(0.18, 0.0, distance(dir, spotDir)) * 0.9;
  c = mix(c, vec3(0.65, 0.28, 0.18), spot * 0.75);
  return c;
}

/** Stellar photosphere: granulation, limb darkening, active regions. */
vec3 starSurface(vec3 dir, vec3 viewDir, out float emissive) {
  vec3 p = dir * 9.0 + vSeed;
  float granulation = fbm(p, 6, 2.13, 0.55);
  float flicker = 0.5 + 0.5 * sin(uTime * 0.7 + granulation * 12.0);
  vec3 base = blackbody(vTemp) * 1.25;
  vec3 c = base * (0.82 + 0.32 * granulation) * (0.96 + 0.06 * flicker);
  // Sunspots: cool patches with a penumbra.
  float spot = smoothstep(0.62, 0.78, fbm(p * 0.7 + 11.0, 4, 2.0, 0.5));
  c = mix(c, base * 0.25, spot);
  // Eddington limb darkening: I(μ)/I(1) = (2 + 3μ)/5.
  float mu = clamp(dot(vNormal, viewDir), 0.0, 1.0);
  c *= (2.0 + 3.0 * mu) / 5.0 * 1.35;
  emissive = 1.0;
  return c;
}

void main() {
  vec3 viewDir = normalize(uCameraPosition - vWorldPos);
  vec3 n = normalize(vNormal);

  float height = 0.0;
  float water = 0.0;
  vec3 albedo;
  float emissive = 0.0;

  if (flag(FLAG_STAR) > 0.5) {
    albedo = starSurface(vLocalDir, viewDir, emissive);
  } else if (flag(FLAG_GAS) > 0.5) {
    albedo = gasSurface(vLocalDir);
  } else {
    albedo = rockySurface(vLocalDir, height, water);
  }
  albedo *= mix(vec3(1.0), vTint * 1.6, 0.35);

  // Lava: an impact or tidal heating has raised the surface above the
  // incandescence threshold, so the hot rock glows and cools visibly as the
  // thermodynamics solver pulls the temperature down.
  if (flag(FLAG_GLOWING) > 0.5 || vTemp > uLavaThreshold) {
    float heat = clamp((vTemp - uLavaThreshold) / 1400.0, 0.0, 1.0);
    float cracks = smoothstep(0.45, 0.75, ridged(vLocalDir * 6.0 + vSeed, 5, 2.1, 0.55));
    float lava = clamp(heat * (0.35 + cracks), 0.0, 1.0);
    vec3 lavaColor = blackbody(mix(1100.0, 1800.0, heat)) * 6.0;
    albedo = mix(albedo, lavaColor, lava);
    emissive = max(emissive, lava);
  }

  // Lambertian shading with a soft terminator, plus a rim of scattered light
  // so the night side is not dead black.
  vec3 L = normalize(uSunPos - vWorldPos);
  float ndl = dot(n, L);
  float wrap = clamp((ndl + 0.08) / 1.08, 0.0, 1.0);
  float shadowSoftness = smoothstep(-0.12, 0.22, ndl);
  vec3 lit = albedo * uSunColor * uSunIntensity * (0.25 * wrap + 0.85 * shadowSoftness);
  float fresnel = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
  lit += albedo * uAmbient * (0.35 + 0.65 * fresnel);

  // Specular highlight on liquid water and smooth ice.
  if (water < 0.5 && flag(FLAG_ROCKY) > 0.5) {
    vec3 h = normalize(L + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 90.0) * (1.0 - water) * uSunIntensity;
    lit += uSunColor * spec * 0.55;
  }

  lit += albedo * emissive;

  // Distant bodies fade toward the fog colour instead of aliasing into noise.
  float d = length(uCameraPosition - vWorldPos);
  lit = mix(lit, lit * 0.35, smoothstep(2.0e12, 2.0e14, d));
  if (flag(FLAG_TRACER) > 0.5) lit *= 0.6;

  gl_FragColor = vec4(lit, 1.0);
}
