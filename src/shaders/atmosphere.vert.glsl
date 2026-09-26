// Atmospheric shell vertex shader. The shell is drawn slightly larger than the
// planet and is rendered back-face-first so the ray-marching fragment shader
// can integrate from the camera to the far side of the atmosphere.
precision highp float;

attribute vec3 aPosition;
attribute vec3 aTint;
attribute float aRadius;
attribute float aTemp;
attribute float aFlags;
attribute float aSeed;
attribute vec3 aAtmos;    // (scaleHeight, betaR, betaM)
attribute float aAtmosRadius;

uniform mat4 uViewProjection;   // projection * view-rotation
uniform vec3 uCameraPosition;
uniform float uScale;
uniform float uExaggeration;

varying vec3 vWorldPos;
varying vec3 vCenter;
varying float vRadius;
varying float vAtmosRadius;
varying vec3 vAtmos;
varying float vTemp;
varying vec3 vTint;
varying float vFlags;

void main() {
  vCenter = aPosition;
  vRadius = aRadius * uExaggeration;
  vAtmosRadius = max(aAtmosRadius, aRadius * 1.02) * uExaggeration;
  vAtmos = aAtmos;
  vTemp = aTemp;
  vTint = aTint;
  vFlags = aFlags;
  vec3 world = vCenter + position * vAtmosRadius;
  vWorldPos = world;
  gl_Position = uViewProjection * vec4((world - uCameraPosition) * uScale, 1.0);
}
