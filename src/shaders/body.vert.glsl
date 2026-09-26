// Instanced body surface vertex shader.
// One draw call for every body in the simulation; per-instance attributes carry
// position, radius, temperature, flags and procedural seed.
precision highp float;

attribute vec3 aPosition;   // instance position, world units (metres)
attribute vec3 aTint;       // linear base colour
attribute float aRadius;    // true radius, metres
attribute float aTemp;      // surface temperature, K
attribute float aFlags;     // bitfield, mirrors BodyFlags
attribute float aSeed;
attribute float aSpin;      // spin phase, radians
attribute vec3 aSpinAxis;   // normalised spin axis
attribute float aVisualScale;
attribute vec3 aAccel;      // gravitational acceleration (for the debug tint)

uniform mat4 uViewProjection;   // projection * view-rotation (no translation)
uniform vec3 uCameraPosition;   // camera in world metres
uniform float uScale;           // metres → render units
uniform float uTime;
uniform float uExaggeration;    // multiplies radii for readability
uniform float uRotationSpeed;
uniform float uPixelScale;   // screen height / (2 tan(fov/2)), for LOD

varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec3 vLocalDir;
varying vec3 vTint;
varying float vTemp;
varying float vFlags;
varying float vSeed;
varying float vRadius;
varying vec3 vSpherePos;
varying float vScreenSize;   // projected radius in pixels, for detail LOD

mat3 axisRotation(vec3 axis, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  float t = 1.0 - c;
  vec3 a = normalize(axis);
  return mat3(
    t * a.x * a.x + c,        t * a.x * a.y - s * a.z,  t * a.x * a.z + s * a.y,
    t * a.x * a.y + s * a.z,  t * a.y * a.y + c,        t * a.y * a.z - s * a.x,
    t * a.x * a.z - s * a.y,  t * a.y * a.z + s * a.x,  t * a.z * a.z + c
  );
}

void main() {
  float radius = aRadius * uExaggeration * max(aVisualScale, 1.0);
  // Spin the sphere about its own axis; the procedural surface is generated in
  // object space, so this is the only animation the surface needs.
  mat3 spin = axisRotation(aSpinAxis, aSpin + uTime * uRotationSpeed);
  vec3 spun = spin * position;
  vLocalDir = normalize(spun);
  vSpherePos = spun;
  vNormal = normalize(mat3(modelMatrix) * spin * normal);
  vec3 world = aPosition + spun * radius;
  vWorldPos = world;
  // Camera-relative rendering: the camera sits at the origin of the render
  // space, so a 5 000 km planet stays crisp while Sedna orbits 1e13 m away.
  gl_Position = uViewProjection * vec4((world - uCameraPosition) * uScale, 1.0);

  vTint = aTint;
  vTemp = aTemp;
  vFlags = aFlags;
  vSeed = aSeed;
  vRadius = radius;
  // Bodies smaller than a pixel are drawn at least 1.25 px wide so the user can
  // still see and click them — the physics radii are untouched.
  float dist = max(length(uCameraPosition - world), 1.0);
  float angular = radius / dist;
  // Projected size in pixels: drives how many noise octaves are worth sampling.
  vScreenSize = angular * uPixelScale;
  if (angular < 1.5e-4) {
    float boost = 1.5e-4 / angular;
    vec3 dir = normalize(spun);
    vec3 grown = aPosition + dir * radius * boost;
    vWorldPos = grown;
    gl_Position = uViewProjection * vec4((grown - uCameraPosition) * uScale, 1.0);
    vRadius = radius * boost;
  }
}
