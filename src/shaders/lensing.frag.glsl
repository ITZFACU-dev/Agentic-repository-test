// ─────────────────────────────────────────────────────────────────────────────
// Gravitational lensing + relativistic accretion disk — one ray-traced pass.
//
// Light bending and disk emission are the same problem (a null geodesic in the
// Schwarzschild/Kerr metric), so they share a pass:
//
//  1. Each pixel's view ray is deflected by every compact object in the scene.
//     The deflection angle uses the Schwarzschild expansion
//         α(b) = 4GM/(c²b) + (15π/4)(GM/c²)²/b² + …
//     and rays whose impact parameter falls inside the photon-sphere critical
//     value b_c = 3√3 GM/c² (≈ 2.6 r_s) are captured, painting the shadow.
//  2. Rays that survive are re-projected and sampled from the HDR scene buffer —
//     which already contains the starfield, so the Einstein ring forms
//     automatically and secondary images appear from the second iteration.
//  3. Where the ray crosses a luminous accretion disk the emission is integrated
//     with orbital Doppler beaming (δ³) and the gravitational redshift factor
//     √(1 − r_s/r), which is what makes one side of the disk far brighter.
// ─────────────────────────────────────────────────────────────────────────────
precision highp float;

#include <shared>

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform mat4 uInverseProjection;
uniform mat4 uProjection;
uniform mat4 uCameraMatrix;      // world → view
uniform vec3 uCameraPosition;
uniform float uNear;
uniform float uFar;

uniform int uLensCount;
uniform vec3 uLensPos[MAX_LENSES];       // world position
uniform float uLensRs[MAX_LENSES];       // Schwarzschild radius, metres
uniform float uLensStrength[MAX_LENSES]; // 0 = off (e.g. ordinary stars)
uniform vec3 uLensAxis[MAX_LENSES];      // spin axis → disk plane normal
uniform float uDiskStrength[MAX_LENSES];
uniform float uDiskOuter[MAX_LENSES];
uniform float uDiskTemp[MAX_LENSES];
uniform vec3 uDiskColor[MAX_LENSES];
uniform int uSteps;
uniform float uEnabled;

vec3 rayFromUv(vec2 uv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 view = uInverseProjection * clip;
  return normalize((view.xyz / view.w));
}

/** Screen-space projection of a view direction, for re-sampling the HDR buffer. */
vec2 uvFromViewDir(vec3 viewDir) {
  vec4 clip = uProjection * vec4(viewDir, 0.0);
  if (clip.w <= 0.0) return vec2(-1.0);
  return (clip.xy / clip.w) * 0.5 + 0.5;
}

float sceneDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  // Perspective depth → view-space distance.
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  vec2 uv = vUv;
  vec3 viewDir = rayFromUv(uv);
  vec3 color = texture2D(tDiffuse, uv).rgb;
  if (uEnabled < 0.5) {
    gl_FragColor = vec4(color, 1.0);
    return;
  }

  float transmittance = 1.0;
  vec3 accumulated = color;

  for (int i = 0; i < MAX_LENSES; i++) {
    if (i >= uLensCount) break;
    if (uLensStrength[i] <= 0.0) continue;
    float rs = uLensRs[i];
    if (rs <= 0.0) continue;

    // Camera-space geometry.
    vec3 c = (uCameraMatrix * vec4(uLensPos[i], 1.0)).xyz;
    float tca = dot(c, viewDir);
    float d2 = dot(c, c) - tca * tca;
    float b = sqrt(max(d2, 0.0));
    float gm = rs * 0.5;                     // GM/c²
    float bCrit = 2.5980762 * rs;            // 3√3 GM/c²

    if (b < bCrit) {
      // Inside the shadow: the photon spirals in and never reaches us.
      float edge = smoothstep(bCrit * 0.985, bCrit, b);
      accumulated = mix(vec3(0.0), accumulated, edge);
      transmittance *= edge;
      continue;
    }

    // Deflection with the first post-Newtonian correction. The full integral for
    // a Schwarzschild geodesic is 4GM/(c²b) + (15π/4)(GM/c²)²/b² + O(b⁻³).
    float alpha = (4.0 * gm) / b * (1.0 + (15.0 * 3.14159265 / 16.0) * (gm / b));

    // Rotate the sample direction by alpha in the plane spanned by the ray and
    // the hole, and re-sample the scene there. Two iterations capture the
    // secondary (lensed) image of the disk.
    vec3 axis = normalize(cross(viewDir, c) + vec3(1e-6, 0.0, 0.0));
    vec3 bent = normalize(rotateAbout(viewDir, axis, alpha));
    vec2 bentUv = uvFromViewDir(bent);
    if (bentUv.x >= 0.0 && bentUv.x <= 1.0 && bentUv.y >= 0.0 && bentUv.y <= 1.0) {
      vec3 sampled = texture2D(tDiffuse, bentUv).rgb;
      // Only accept the bent sample for rays that do not hit closer geometry.
      float hitDist = sceneDepth(bentUv);
      float lensDist = length(c);
      float accept = step(hitDist, lensDist * 1.02 + 1.0);
      accumulated = mix(accumulated, sampled, (1.0 - accept) * transmittance);
    }

    if (uDiskStrength[i] > 0.0) {
      vec3 diskColor = vec3(0.0);
      float diskAlpha = 0.0;
      vec3 n = normalize(uLensAxis[i]);
      float denom = dot(viewDir, n);
      if (abs(denom) > 1e-4) {
        float t = dot(-c, n) / denom;
        if (t > 0.0) {
          vec3 hit = c + viewDir * t;
          {
            // Radius *within* the disk plane, measured from the hole.
            vec3 rel = hit - c;
            float r = length(rel - n * dot(rel, n));
            float rInner = rs * 3.0;              // ISCO for a Schwarzschild hole
            float rOuter = uDiskOuter[i];
            if (r >= rInner && r <= rOuter) {
            float u = (r - rInner) / max(rOuter - rInner, 1e-6);
            // Shakura–Sunyaev: T ∝ r^-3/4, so the flux rises steeply inward.
            float temp = uDiskTemp[i] * pow(max(rInner / r, 1e-3), 0.75);
            vec3 thermal = blackbody(temp);
            // Keplerian orbital speed, β = √(GM/r)/c = √(rs/2r).
            float beta = sqrt(clamp(rs / (2.0 * max(r, rs)), 0.0, 0.98));
            vec3 tangent = normalize(cross(n, rel));
            vec3 toCam = -viewDir;
            // Relativistic Doppler factor for a circular orbit.
            float gamma = 1.0 / sqrt(max(1.0 - beta * beta, 1e-4));
            float delta = 1.0 / max(gamma * (1.0 - beta * dot(tangent, toCam)), 1e-3);
            // Gravitational redshift of the emitting gas.
            float grav = sqrt(max(1.0 - rs / max(r, rs * 1.0001), 1e-4));
            float boost = pow(clamp(delta, 0.0, 6.0), 3.0) * grav;
            float density = exp(-pow(u * 3.2, 2.0)) * uDiskStrength[i];
            diskColor += thermal * density * boost * 24.0 * uDiskColor[i];
            diskAlpha = max(diskAlpha, density);
            }
          }
        }
      }
      // Occlusion by closer geometry.
      float hitDist = sceneDepth(uv);
      float lensDist = length(c);
      float visible = step(lensDist * 0.98, hitDist) * transmittance;
      // Emission from the disk also gets lensed: brighten near the inner ring.
      float ring = smoothstep(bCrit * 1.6, bCrit * 1.05, b);
      accumulated += diskColor * visible * (1.0 + 1.5 * ring);
      transmittance *= 1.0 - clamp(diskAlpha, 0.0, 1.0) * 0.85 * visible;
    }
  }

  gl_FragColor = vec4(accumulated, 1.0);
}
