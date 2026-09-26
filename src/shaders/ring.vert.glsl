// Instanced ring / debris particles. Each instance is a camera-facing quad
// whose world position is the host body's centre plus the particle's
// body-space offset, so a ring inherits its planet's motion for free.
precision highp float;

attribute vec3 aHost;      // host body centre, world metres
attribute vec3 aOffset;    // particle offset in body space, metres
attribute float aSize;     // particle diameter, metres
attribute float aTemp;     // temperature, K

uniform mat4 uViewProjection;
uniform vec3 uCameraPosition;
uniform float uScale;

varying vec2 vUv;
varying float vTemp;

void main() {
  vUv = uv;
  vTemp = aTemp;
  vec3 world = aHost + aOffset;
  vec4 viewPos = uViewProjection * vec4((world - uCameraPosition) * uScale, 1.0);
  // Billboard: expand in clip space so the particle keeps a constant screen
  // size, clamped so distant rings do not vanish entirely.
  float dist = max(length(uCameraPosition - world), 1.0);
  float projected = clamp(aSize / dist, 2.5e-4, 3.0e-2);
  viewPos.xy += position.xy * projected * viewPos.w;
  gl_Position = viewPos;
}
