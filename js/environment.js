import * as THREE from 'three';

// Sun direction used for the sky highlight, image-based lighting and the
// directional (shadow-casting) light, so reflections and shadows agree.
export const SUN_DIR = new THREE.Vector3(-0.62, 0.55, 0.42).normalize();

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uSun;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zenith  = vec3(0.30, 0.46, 0.70);
  vec3 horizon = vec3(0.92, 0.91, 0.88);
  vec3 ground  = vec3(0.70, 0.67, 0.60);
  vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.55)) : mix(horizon, ground, pow(-h, 0.4));
  float s = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.92, 0.78) * (pow(s, 900.0) * 14.0 + pow(s, 40.0) * 0.55 + pow(s, 6.0) * 0.12);
  gl_FragColor = vec4(col, 1.0);
}`;

// Soft sky dome baked into a PMREM environment map: gives the water, the
// orbs and the terrain believable reflections and ambient light.
export function buildEnvironment(renderer) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uSun: { value: SUN_DIR.clone() } },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthWrite: false,
    }),
  );
  const envScene = new THREE.Scene();
  envScene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.015);
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return target.texture;
}

// Vertical gradient used as the page backdrop.
export function buildBackground() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, '#cfdbe6');
  grad.addColorStop(0.42, '#e8edf0');
  grad.addColorStop(0.7, '#f3f1ec');
  grad.addColorStop(1.0, '#e7e3da');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft blurred ellipse beneath the block, so the diorama "floats" on the page.
export function buildContactShadow(width, depth, y) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 20, 128, 128, 126);
  grad.addColorStop(0, 'rgba(35,45,55,0.42)');
  grad.addColorStop(0.55, 'rgba(35,45,55,0.16)');
  grad.addColorStop(1, 'rgba(35,45,55,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 1.35, depth * 1.7),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = -1;
  return mesh;
}
