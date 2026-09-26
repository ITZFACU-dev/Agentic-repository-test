precision highp float;
uniform mat4 uViewProjection;
uniform float uRadius;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = uViewProjection * vec4(position * uRadius, 1.0);
  // Push the sky to the far plane so nothing can ever clip it.
  gl_Position.z = gl_Position.w * 0.999999;
}
