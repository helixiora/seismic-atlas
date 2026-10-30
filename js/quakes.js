import * as THREE from 'three';
import { groundY, lonToX, latToZ, V_SCALE } from './projection.js';

export const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

// Continuous depth ramp (km -> colour): hot/shallow to cool/deep.
const DEPTH_STOPS = [
  [0, '#e5243b'], [12, '#ef4a2a'], [30, '#f58a2c'], [55, '#c2409a'], [100, '#6a4bd0'], [200, '#1f6fd6'],
].map(([d, c]) => [d, new THREE.Color(c)]);

export function depthColor(km, out = new THREE.Color()) {
  if (km <= DEPTH_STOPS[0][0]) return out.copy(DEPTH_STOPS[0][1]);
  for (let s = 1; s < DEPTH_STOPS.length; s++) {
    if (km <= DEPTH_STOPS[s][0]) {
      const [d0, c0] = DEPTH_STOPS[s - 1];
      const [d1, c1] = DEPTH_STOPS[s];
      return out.copy(c0).lerp(c1, (km - d0) / (d1 - d0));
    }
  }
  return out.copy(DEPTH_STOPS[DEPTH_STOPS.length - 1][1]);
}

export const magRadius = (m) => THREE.MathUtils.clamp(0.22 + (m - 3.5) * 0.38, 0.22, 2.3);

const COMMON_ATTRS = /* glsl */`
attribute float aTime;
attribute float aDrop;
attribute float aMag;
uniform float uTime;
uniform float uDepthMix;
uniform float uPulse;
uniform float uFade;
uniform float uFadeYears;
`;

const ORB_BEGIN = /* glsl */`
float age = uTime - aTime;
float magR = clamp(0.22 + (aMag - 3.5) * 0.38, 0.22, 2.3);
float P = uPulse * clamp(0.35 + (aMag - 3.5) * 0.4, 0.35, 2.2);
float decay = 1.0 - clamp(age / P, 0.0, 1.0);
float kFade = clamp(1.0 - age / uFadeYears, 0.08, 1.0);
float settle = 0.55 * mix(1.0, 0.45 + 0.55 * kFade, uFade);
float pop = smoothstep(0.0, 0.05, age);
float rad = magR * (settle + 1.15 * decay * decay) * pop;
vGlow = decay * decay * pop;
vK = mix(1.0, kFade, uFade);
vec3 transformed = vec3(position) * rad;
`;

const ORB_PROJECT = /* glsl */`
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mat4 instM = instanceMatrix;
  instM[3].y += rad * 0.35 * (1.0 - uDepthMix) - aDrop * uDepthMix;
  mvPosition = instM * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
if (age < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

const HALO_VERT = /* glsl */`
${COMMON_ATTRS}
attribute vec3 aColor;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
void main() {
  float age = uTime - aTime;
  float P = uPulse * clamp(0.35 + (aMag - 3.5) * 0.4, 0.35, 2.2);
  float decay = 1.0 - clamp(age / P, 0.0, 1.0);
  float magR = clamp(0.22 + (aMag - 3.5) * 0.38, 0.22, 2.3);
  vec3 c = instanceMatrix[3].xyz;
  c.y += 0.3 * (1.0 - uDepthMix) - aDrop * uDepthMix;
  float size = magR * (1.1 + 4.2 * decay);
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  if (age < 0.0 || age > P) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = position.xy;
  vCol = aColor;
  vAlpha = pow(decay, 1.5) * smoothstep(0.0, 0.04, age);
}`;

const HALO_FRAG = /* glsl */`
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.3) * 0.62;
  a += smoothstep(0.78, 0.9, d) * smoothstep(1.0, 0.9, d) * 0.22;
  gl_FragColor = vec4(mix(vCol, vec3(1.0, 0.9, 0.8), 0.18), a * vAlpha);
  #include <colorspace_fragment>
}`;

const STEM_VERT = /* glsl */`
${COMMON_ATTRS}
attribute float aEnd;
attribute vec3 aColor;
varying vec3 vCol;
varying float vAlpha;
void main() {
  float age = uTime - aTime;
  float P = uPulse * clamp(0.35 + (aMag - 3.5) * 0.4, 0.35, 2.2);
  float decay = 1.0 - clamp(age / P, 0.0, 1.0);
  float kFade = clamp(1.0 - age / uFadeYears, 0.08, 1.0);
  vec3 p = position;
  p.y -= aEnd * aDrop * uDepthMix;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  if (age < 0.0 || uDepthMix < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vCol = aColor;
  float big = smoothstep(3.6, 6.4, aMag);
  vAlpha = uDepthMix * (0.14 + 0.5 * decay + 0.25 * big) * mix(1.0, 0.45, aEnd) * mix(1.0, kFade, uFade);
}`;

const STEM_FRAG = /* glsl */`
varying vec3 vCol;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vCol, vAlpha);
  #include <colorspace_fragment>
}`;

export class Quakes {
  constructor({ scene, quakes }) {
    this.scene = scene;
    this.quakes = quakes;
    this.N = quakes.length;
    this.minMs = quakes[0].ms;
    this.maxMs = quakes[this.N - 1].ms;
    this.uniforms = {
      uTime: { value: 0 },
      uDepthMix: { value: 0 },
      uPulse: { value: 1.2 },
      uFade: { value: 0 },
      uFadeYears: { value: 25 },
    };
    this.surface = new Float32Array(this.N * 3); // x, groundY, z
    this.build();
  }

  build() {
    const N = this.N;
    const times = new Float32Array(N);
    const drops = new Float32Array(N);
    const mags = new Float32Array(N);
    const colors = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const q = this.quakes[i];
      times[i] = (q.ms - this.minMs) / MS_PER_YEAR;
      drops[i] = Math.min(q.depth, 200) * V_SCALE;
      mags[i] = q.mag;
      depthColor(q.depth, c);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const mkAttr = (arr, size) => new THREE.InstancedBufferAttribute(arr, size);
    const aTime = mkAttr(times, 1), aDrop = mkAttr(drops, 1), aMag = mkAttr(mags, 1);

    // --- Orbs: physically shaded spheres, animated entirely on the GPU. ---
    const geo = new THREE.SphereGeometry(1, 18, 12);
    geo.setAttribute('aTime', aTime);
    geo.setAttribute('aDrop', aDrop);
    geo.setAttribute('aMag', aMag);
    const mat = new THREE.MeshPhysicalMaterial({
      roughness: 0.3, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.18, envMapIntensity: 1.1,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${COMMON_ATTRS}\nvarying float vGlow;\nvarying float vK;`)
        .replace('#include <begin_vertex>', ORB_BEGIN)
        .replace('#include <project_vertex>', ORB_PROJECT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying float vK;\nuniform float uFade;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.333))) * 0.9 + 0.08, (1.0 - vK) * 0.8);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * vGlow * 0.85 + vec3(1.0, 0.85, 0.7) * vGlow * 0.07;`);
    };
    const orbs = new THREE.InstancedMesh(geo, mat, N);
    orbs.instanceColor = mkAttr(colors, 3);
    orbs.frustumCulled = false;
    orbs.renderOrder = 4;
    this.orbs = orbs;

    // --- Halos: soft billboard glow around fresh events. ---
    const hgeo = new THREE.PlaneGeometry(2, 2);
    hgeo.setAttribute('aTime', aTime);
    hgeo.setAttribute('aDrop', aDrop);
    hgeo.setAttribute('aMag', aMag);
    hgeo.setAttribute('aColor', mkAttr(colors, 3));
    const hmat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
      uniforms: this.uniforms, transparent: true, depthWrite: false,
    });
    const halos = new THREE.InstancedMesh(hgeo, hmat, N);
    halos.instanceMatrix = orbs.instanceMatrix;
    halos.frustumCulled = false;
    halos.renderOrder = 5;
    this.halos = halos;

    // --- Stems: surface-to-hypocentre drop lines (visible in depth view). ---
    const sg = new THREE.BufferGeometry();
    const sPos = new Float32Array(N * 6);
    const sTime = new Float32Array(N * 2), sDrop = new Float32Array(N * 2), sMag = new Float32Array(N * 2);
    const sEnd = new Float32Array(N * 2), sCol = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        sTime[k] = times[i]; sDrop[k] = drops[i]; sMag[k] = mags[i]; sEnd[k] = e;
        sCol[k * 3] = colors[i * 3]; sCol[k * 3 + 1] = colors[i * 3 + 1]; sCol[k * 3 + 2] = colors[i * 3 + 2];
      }
    }
    this.stemPos = sPos;
    sg.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    sg.setAttribute('aTime', new THREE.BufferAttribute(sTime, 1));
    sg.setAttribute('aDrop', new THREE.BufferAttribute(sDrop, 1));
    sg.setAttribute('aMag', new THREE.BufferAttribute(sMag, 1));
    sg.setAttribute('aEnd', new THREE.BufferAttribute(sEnd, 1));
    sg.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
    const smat = new THREE.ShaderMaterial({
      vertexShader: STEM_VERT, fragmentShader: STEM_FRAG,
      uniforms: this.uniforms, transparent: true, depthWrite: false,
    });
    const stems = new THREE.LineSegments(sg, smat);
    stems.frustumCulled = false;
    stems.renderOrder = 3;
    this.stems = stems;

    scene_add(this.scene, stems, orbs, halos);
    this.updatePositions();
  }

  dispose() {
    for (const o of [this.stems, this.orbs, this.halos]) {
      this.scene.remove(o);
      o.geometry.dispose();
      o.material.dispose();
      if (o.dispose) o.dispose();
    }
  }

  // Recompute surface anchor points (call after the relief changes).
  updatePositions() {
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.N; i++) {
      const q = this.quakes[i];
      const x = lonToX(q.lon), z = latToZ(q.lat), y = groundY(q.lon, q.lat);
      this.surface[i * 3] = x; this.surface[i * 3 + 1] = y; this.surface[i * 3 + 2] = z;
      m.makeTranslation(x, y, z);
      this.orbs.setMatrixAt(i, m);
      for (let e = 0; e < 2; e++) {
        const k = (i * 2 + e) * 3;
        this.stemPos[k] = x; this.stemPos[k + 1] = y + 0.02; this.stemPos[k + 2] = z;
      }
    }
    this.orbs.instanceMatrix.needsUpdate = true;
    this.stems.geometry.attributes.position.needsUpdate = true;
  }

  setTime(ms) {
    this.uniforms.uTime.value = (ms - this.minMs) / MS_PER_YEAR;
  }

  // Sorted by time, so the revealed events are a prefix: skip drawing the rest entirely.
  setRevealed(n) {
    this.orbs.count = n;
    this.halos.count = n;
    this.stems.geometry.setDrawRange(0, n * 2);
  }

  setDepthMix(v) {
    this.uniforms.uDepthMix.value = v;
    this.stems.visible = v > 0.02;
  }

  setFade(on) {
    this.uniforms.uFade.value = on ? 1 : 0;
  }

  // Number of quakes with time <= ms.
  countUpTo(ms) {
    let lo = 0, hi = this.N;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.quakes[mid].ms <= ms) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  worldPosition(i, out = new THREE.Vector3()) {
    const mix = this.uniforms.uDepthMix.value;
    return out.set(
      this.surface[i * 3],
      this.surface[i * 3 + 1] - this.quakes[i].depth * V_SCALE * mix,
      this.surface[i * 3 + 2],
    );
  }

  // Nearest revealed event to a screen point (CSS pixels), or -1.
  pick(camera, clientX, clientY, width, height, revealed, radiusPx = 14) {
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = radiusPx * radiusPx;
    for (let i = 0; i < revealed; i++) {
      this.worldPosition(i, v).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const dx = (v.x * 0.5 + 0.5) * width - clientX;
      const dy = (-v.y * 0.5 + 0.5) * height - clientY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
}

function scene_add(scene, ...objs) {
  for (const o of objs) scene.add(o);
}
