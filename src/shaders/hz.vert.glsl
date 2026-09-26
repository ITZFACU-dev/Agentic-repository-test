// Instanced habitable-zone ribbon vertex shader.
precision highp float;

attribute vec3 aCenter;      // host star, world metres
attribute float aInner;      // band inner radius, metres
attribute float aOuter;      // band outer radius, metres
attribute vec3 aColor;
attribute float aMode;       // 0 = conservative, 1 = optimistic

uniform mat4 uViewProjection;
uniform vec3 uCameraPosition;
uniform float uScale;

varying vec2 vLocal;
varying vec3 vColor;
varying float vMode;
varying float vRadial;

void main() {
  vLocal = uv;
  vColor = aColor;
  vMode = aMode;
  vec3 local = position;                    // unit annulus in the XZ plane
  float r = mix(aInner, aOuter, (length(local.xz) - 0.7) / 0.3);
  vec3 dir = normalize(vec3(local.x, 0.0, local.z) + vec3(1e-6));
  vec3 world = aCenter + dir * r;
  vRadial = r;
  gl_Position = uViewProjection * vec4((world - uCameraPosition) * uScale, 1.0);
}
