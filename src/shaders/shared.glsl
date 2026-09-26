// ─────────────────────────────────────────────────────────────────────────────
// shared.glsl — noise, colour and lighting helpers shared by every surface
// shader.  All noise is derivative-free value noise built on a hash, which
// keeps it cheap enough to run per-fragment on a 300-body scene.
// ─────────────────────────────────────────────────────────────────────────────

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

// Gradient (Perlin-style) noise — smooth enough for terrain, cheaper than simplex.
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = dot(hash33(i + vec3(0, 0, 0)) * 2.0 - 1.0, f - vec3(0, 0, 0));
  float n100 = dot(hash33(i + vec3(1, 0, 0)) * 2.0 - 1.0, f - vec3(1, 0, 0));
  float n010 = dot(hash33(i + vec3(0, 1, 0)) * 2.0 - 1.0, f - vec3(0, 1, 0));
  float n110 = dot(hash33(i + vec3(1, 1, 0)) * 2.0 - 1.0, f - vec3(1, 1, 0));
  float n001 = dot(hash33(i + vec3(0, 0, 1)) * 2.0 - 1.0, f - vec3(0, 0, 1));
  float n101 = dot(hash33(i + vec3(1, 0, 1)) * 2.0 - 1.0, f - vec3(1, 0, 1));
  float n011 = dot(hash33(i + vec3(0, 1, 1)) * 2.0 - 1.0, f - vec3(0, 1, 1));
  float n111 = dot(hash33(i + vec3(1, 1, 1)) * 2.0 - 1.0, f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

const mat3 OCT_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Multi-octave fractional Brownian motion. `lacunarity`/`gain` are exposed so a
// gas giant's turbulence and a moon's cratered crust can share this function.
float fbm(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    sum += amp * noise3(p);
    norm += amp;
    amp *= gain;
    p = OCT_ROT * p * lacunarity;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

float ridged(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    sum += amp * (1.0 - abs(noise3(p)));
    norm += amp;
    amp *= gain;
    p = OCT_ROT * p * lacunarity;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// Domain warp: the single cheapest trick that turns smooth fbm into
// continent-like coastlines and turbulent cloud decks.
float warpedFbm(vec3 p, int octaves, float warp) {
  vec3 q = vec3(fbm(p + vec3(1.7, 9.2, 3.3), 3, 2.0, 0.5),
                fbm(p + vec3(8.3, 2.8, 6.1), 3, 2.0, 0.5),
                fbm(p + vec3(3.9, 7.1, 1.3), 3, 2.0, 0.5));
  return fbm(p + warp * q, octaves, 2.02, 0.5);
}

// ── Colour science ───────────────────────────────────────────────────────────

// Tanner Helland's Planck-locus fit: temperature (K) → linear sRGB.
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r, g, b;
  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(t) - 161.1195681661;
    b = t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307;
  } else {
    r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
    b = 255.0;
  }
  vec3 c = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  return pow(c, vec3(2.2)); // approximate sRGB → linear
}

// ACES filmic tone-mapping (Narkowicz fit) for the LDR output stage.
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/** Rodrigues rotation of v about a unit axis — used by the lensing pass. */
vec3 rotateAbout(vec3 v, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  vec3 k = normalize(axis);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
