import * as THREE from 'three';
import { world, lonToX, latToZ, V_SCALE, KM_LON, KM_LAT, H_SCALE } from './projection.js';

export const MAX_WAVES = 24;

// ---------------------------------------------------------------------------
// Block walls: the geological cross-section around the map.
// Each wall vertex carries its elevation in metres (aH) and a mode saying
// which height it represents, so the relief slider only needs a uniform.
// ---------------------------------------------------------------------------
const WALL_VERT = /* glsl */`
attribute vec3 color;
attribute float aKind;   // 0 crust, 1 water column
attribute float aMode;   // 0 surface, 1 base, 2 sea level, 3 sea floor
attribute float aH;
uniform float uRelief;
uniform float uBaseY;
varying vec3 vColor;
varying float vKind;
varying float vY;
void main() {
  float y = aMode < 0.5 ? aH * uRelief : aMode < 1.5 ? uBaseY : aMode < 2.5 ? 0.0 : min(aH, 0.0) * uRelief;
  vColor = color;
  vKind = aKind;
  vY = y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, y, position.z, 1.0);
}`;

const WALL_FRAG = /* glsl */`
uniform float uShade;
uniform float uKmPerUnit;
uniform float uRelief;
uniform float uOpacity;
varying vec3 vColor;
varying float vKind;
varying float vY;
void main() {
  float km = max(-vY, 0.0) * uKmPerUnit;
  vec3 col;
  float alpha;
  if (vKind < 0.5) {
    float t = smoothstep(0.0, 26.0, km);
    col = mix(vColor * 0.95, vec3(0.74, 0.78, 0.83), t * 0.92);
    alpha = 0.07 + 0.90 * exp(-km / 42.0);
  } else {
    float wm = max(-vY, 0.0) / max(uRelief, 1e-5);
    col = mix(vec3(0.66, 0.86, 0.91), vec3(0.24, 0.50, 0.70), smoothstep(0.0, 800.0, wm));
    alpha = 0.78;
  }
  float fw = max(fwidth(km), 1e-4);
  float d10 = abs(fract(km / 10.0 + 0.5) - 0.5) * 10.0;
  float d50 = abs(fract(km / 50.0 + 0.5) - 0.5) * 50.0;
  float l10 = 1.0 - smoothstep(0.0, fw * 1.1, d10);
  float l50 = 1.0 - smoothstep(0.0, fw * 1.6, d50);
  float lineMask = (vKind < 0.5 && vY < 0.0) ? 1.0 : 0.0;
  col = mix(col, vec3(1.0), lineMask * (l10 * 0.20 + l50 * 0.34));
  float dz = abs(vY) / max(fwidth(vY), 1e-4);
  col = mix(col, vec3(0.20, 0.38, 0.52), (1.0 - smoothstep(0.0, 1.4, dz)) * 0.5);
  col *= uShade;
  gl_FragColor = vec4(col, alpha * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function mulberry(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWaterNormals() {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const hgt = new Float32Array(S * S);
  const rnd = mulberry(11);
  const waves = [];
  for (let k = 0; k < 9; k++) {
    const ang = rnd() * Math.PI * 2;
    const f = 2 + Math.floor(rnd() * 6);
    waves.push({ kx: Math.round(Math.cos(ang) * f), ky: Math.round(Math.sin(ang) * f), ph: rnd() * 6.28, amp: 1 / (1 + f * 0.35) });
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (const w of waves) v += Math.sin(((x * w.kx + y * w.ky) / S) * Math.PI * 2 + w.ph) * w.amp;
      hgt[y * S + x] = v;
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x + S - 1) % S)];
      const dy = hgt[((y + 1) % S) * S + x] - hgt[((y + S - 1) % S) * S + x];
      const nx = -dx * 0.6, ny = -dy * 0.6, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (y * S + x) * 4;
      data[o] = (nx / l * 0.5 + 0.5) * 255;
      data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class Terrain {
  constructor({ scene, albedo, albedoPixels, maxAnisotropy = 8 }) {
    this.scene = scene;
    this.albedo = albedo;
    this.albedoPixels = albedoPixels;
    this.maxAnisotropy = maxAnisotropy;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.waveVecs = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4(0, 0, 0, 0));
    this.waveCols = Array.from({ length: MAX_WAVES }, () => new THREE.Vector3(1, 0.2, 0.1));
    this.xray = 0;
    this.waterNormals = buildWaterNormals();
    this.wallMats = [];

    // Heights as a half-float texture: displacement and normals come from it on the GPU.
    const { w, h } = world.meta;
    const half = new Uint16Array(w * h);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(world.heights[i]);
    this.heightTex = new THREE.DataTexture(half, w, h, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    this.uniforms = {
      uHeightTex: { value: this.heightTex },
      uRelief: { value: world.relief },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uDx: { value: ((world.meta.lonMax - world.meta.lonMin) / (w - 1)) * KM_LON * H_SCALE },
      uDz: { value: ((world.meta.latMax - world.meta.latMin) / (h - 1)) * KM_LAT * H_SCALE },
    };
    this.buildTerrain();
    this.buildWater();
    this.buildWalls();
    this.setXray(0);
  }

  setRelief(r) {
    world.relief = r;
    this.uniforms.uRelief.value = r;
    for (const m of this.wallMats) m.uniforms.uRelief.value = r;
  }

  buildTerrain() {
    const { w, h, lonMin, lonMax, latMin, latMax } = world.meta;
    const stride = 2;
    const nx = Math.floor((w - 1) / stride) + 1;
    const ny = Math.floor((h - 1) / stride) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    const nrm = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) {
      const sj = Math.round((j * (h - 1)) / (ny - 1));
      const lat = latMin + ((latMax - latMin) * sj) / (h - 1);
      const z = latToZ(lat);
      for (let i = 0; i < nx; i++) {
        const si = Math.round((i * (w - 1)) / (nx - 1));
        const lon = lonMin + ((lonMax - lonMin) * si) / (w - 1);
        const k = j * nx + i;
        pos[k * 3] = lonToX(lon);
        pos[k * 3 + 2] = z;
        nrm[k * 3 + 1] = 1;
        uv[k * 2] = (si + 0.5) / w;
        uv[k * 2 + 1] = (sj + 0.5) / h;
      }
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let p = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[p++] = a; idx[p++] = b; idx[p++] = c;
        idx[p++] = b; idx[p++] = d; idx[p++] = c;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));

    const mat = new THREE.MeshStandardMaterial({
      map: this.albedo,
      roughness: 0.93,
      metalness: 0,
      envMapIntensity: 0.42,
      transparent: true,
    });
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.uniforms.uWaves = { value: this.waveVecs };
      shader.uniforms.uWaveCol = { value: this.waveCols };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uHeightTex;
          uniform float uRelief;
          varying vec3 vObjPos;
          varying vec2 vHUv;`)
        .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
          transformed.y = texture2D(uHeightTex, uv).r * uRelief;
          vObjPos = transformed;
          vHUv = uv;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uHeightTex;
          uniform float uRelief;
          uniform vec2 uTexel;
          uniform float uDx;
          uniform float uDz;
          varying vec3 vObjPos;
          varying vec2 vHUv;
          uniform vec4 uWaves[${MAX_WAVES}];
          uniform vec3 uWaveCol[${MAX_WAVES}];
          float vhash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float vnoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(vhash(i), vhash(i + vec2(1.0, 0.0)), f.x), mix(vhash(i + vec2(0.0, 1.0)), vhash(i + vec2(1.0, 1.0)), f.x), f.y);
          }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            float hL = texture2D(uHeightTex, vHUv - vec2(uTexel.x, 0.0)).r;
            float hR = texture2D(uHeightTex, vHUv + vec2(uTexel.x, 0.0)).r;
            float hD = texture2D(uHeightTex, vHUv - vec2(0.0, uTexel.y)).r;
            float hU = texture2D(uHeightTex, vHUv + vec2(0.0, uTexel.y)).r;
            float dhdx = (hR - hL) * uRelief / (2.0 * uDx);
            float dhdj = (hU - hD) * uRelief / (2.0 * uDz);
            vec3 nObj = normalize(vec3(-dhdx, 1.0, dhdj));
            // Rocky micro-relief that only appears up close, on land.
            float fade = smoothstep(95.0, 22.0, length(vViewPosition)) * step(0.02, vObjPos.y);
            if (fade > 0.001) {
              vec2 p = vObjPos.xz * 7.0;
              vec2 g1 = vec2(vnoise(p + vec2(0.4, 0.0)) - vnoise(p - vec2(0.4, 0.0)), vnoise(p + vec2(0.0, 0.4)) - vnoise(p - vec2(0.0, 0.4)));
              vec2 q = vObjPos.xz * 19.0;
              vec2 g2 = vec2(vnoise(q + vec2(0.4, 0.0)) - vnoise(q - vec2(0.4, 0.0)), vnoise(q + vec2(0.0, 0.4)) - vnoise(q - vec2(0.0, 0.4)));
              float rough = 0.35 + 0.65 * clamp(length(vec2(dhdx, dhdj)) * 1.6, 0.0, 1.0);
              nObj = normalize(nObj + vec3(g1.x + 0.6 * g2.x, 0.0, g1.y + 0.6 * g2.y) * 0.55 * fade * rough);
            }
            normal = normalize(mat3(viewMatrix) * nObj);
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float ringSum = 0.0; vec3 ringCol = vec3(0.0);
          for (int i = 0; i < ${MAX_WAVES}; i++) {
            vec4 wv = uWaves[i];
            if (wv.w > 0.001) {
              float d = distance(vObjPos.xz, wv.xy);
              float wd = 0.22 + 0.045 * wv.z;
              float ring = exp(-pow((d - wv.z) / wd, 2.0)) * wv.w;
              float core = exp(-pow(d / (0.7 + 0.09 * wv.z), 2.0)) * wv.w * 0.75;
              float a = clamp(ring + core, 0.0, 1.0);
              ringCol += uWaveCol[i] * a;
              ringSum += a;
            }
          }
          ringSum = min(ringSum, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, ringCol / max(ringSum, 0.001), ringSum * 0.82);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += ringCol * 0.3;`);
    };
    this.terrainMat = mat;

    // The shadow pass needs the same displacement.
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depthMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uHeightTex: U.uHeightTex, uRelief: U.uRelief });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uHeightTex;\nuniform float uRelief;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y = texture2D(uHeightTex, uv).r * uRelief;');
    };

    const mesh = new THREE.Mesh(geom, mat);
    mesh.customDepthMaterial = depthMat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.terrainMesh = mesh;
    this.group.add(mesh);
  }

  buildWater() {
    const { xMin, xMax, zMin, zMax } = world.extent;
    this.waterNormals.repeat.set(26, 10);
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: 0xa9dbe6,
      roughness: 0.07,
      metalness: 0.0,
      transparent: true,
      opacity: 0.36,
      envMapIntensity: 1.6,
      normalMap: this.waterNormals,
      normalScale: new THREE.Vector2(0.22, 0.22),
      depthWrite: false,
      clearcoat: 0.5,
      clearcoatRoughness: 0.1,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(xMax - xMin, zMax - zMin), this.waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set((xMin + xMax) / 2, 0, (zMin + zMax) / 2);
    water.renderOrder = 1;
    this.water = water;
    this.group.add(water);
  }

  rockColor(i, j, hM, out) {
    if (hM <= 0) { out.setRGB(0.80, 0.77, 0.69, THREE.SRGBColorSpace); return out; }
    const { w, h } = world.meta;
    const px = this.albedoPixels;
    const o = ((h - 1 - j) * w + i) * 4;
    out.setRGB(px.data[o] / 255, px.data[o + 1] / 255, px.data[o + 2] / 255, THREE.SRGBColorSpace);
    return out;
  }

  buildWalls() {
    const { w, h, lonMin, lonMax, latMin, latMax } = world.meta;
    const col = new THREE.Color();
    const stepN = 2;
    const sides = [
      { shade: 1.0, along: 'i', fixed: 0 },
      { shade: 0.93, along: 'i', fixed: h - 1 },
      { shade: 0.86, along: 'j', fixed: 0 },
      { shade: 0.80, along: 'j', fixed: w - 1 },
    ];
    this.wallMats = [];
    for (const side of sides) {
      const count = side.along === 'i' ? w : h;
      const samples = [];
      for (let k = 0; k < count; k += stepN) samples.push(k);
      if (samples[samples.length - 1] !== count - 1) samples.push(count - 1);
      const n = samples.length;
      const pos = new Float32Array(n * 4 * 3);
      const colors = new Float32Array(n * 4 * 3);
      const kind = new Float32Array(n * 4);
      const mode = new Float32Array(n * 4);
      const aH = new Float32Array(n * 4);
      const modes = [0, 1, 2, 3];
      for (let s = 0; s < n; s++) {
        const i = side.along === 'i' ? samples[s] : side.fixed;
        const j = side.along === 'i' ? side.fixed : samples[s];
        const lon = lonMin + ((lonMax - lonMin) * i) / (w - 1);
        const lat = latMin + ((latMax - latMin) * j) / (h - 1);
        const x = lonToX(lon), z = latToZ(lat);
        const hM = world.heights[j * w + i];
        this.rockColor(i, j, hM, col);
        for (let v = 0; v < 4; v++) {
          const o = (s * 4 + v) * 3;
          pos[o] = x; pos[o + 2] = z;
          if (v < 2) { colors[o] = col.r; colors[o + 1] = col.g; colors[o + 2] = col.b; }
          else { colors[o] = 0.6; colors[o + 1] = 0.82; colors[o + 2] = 0.9; }
          kind[s * 4 + v] = v < 2 ? 0 : 1;
          mode[s * 4 + v] = modes[v];
          aH[s * 4 + v] = hM;
        }
      }
      const idx = [];
      for (let s = 0; s < n - 1; s++) {
        const a = s * 4, b = (s + 1) * 4;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
        idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
      g.setAttribute('aMode', new THREE.BufferAttribute(mode, 1));
      g.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
      g.setIndex(idx);
      const m = new THREE.ShaderMaterial({
        vertexShader: WALL_VERT,
        fragmentShader: WALL_FRAG,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uShade: { value: side.shade },
          uKmPerUnit: { value: 1 / V_SCALE },
          uOpacity: { value: 1 },
          uRelief: { value: world.relief },
          uBaseY: { value: world.baseY },
        },
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.wallMats.push(m);
      this.group.add(mesh);
    }

    const { xMin, xMax, zMin, zMax } = world.extent;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(xMax - xMin, zMax - zMin),
      new THREE.MeshBasicMaterial({ color: 0xdfe5ea, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, fog: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((xMin + xMax) / 2, world.baseY, (zMin + zMax) / 2);
    floor.renderOrder = 0;
    this.group.add(floor);
  }

  // 0 = opaque surface, 1 = see-through (depth view).
  setXray(v) {
    this.xray = v;
    this.terrainMat.opacity = THREE.MathUtils.lerp(1, 0.4, v);
  }

  setWaves(list, nowSec) {
    for (let i = 0; i < MAX_WAVES; i++) {
      const wv = this.waveVecs[i];
      const w = list[i];
      if (!w) { wv.w = 0; continue; }
      const t = (nowSec - w.t0) / w.life;
      const eased = 1 - Math.pow(1 - THREE.MathUtils.clamp(t, 0, 1), 2.2);
      wv.set(w.x, w.z, w.maxR * eased, w.strength * Math.pow(1 - THREE.MathUtils.clamp(t, 0, 1), 1.4));
      this.waveCols[i].set(w.color.r, w.color.g, w.color.b);
    }
  }

  update(time) {
    this.waterNormals.offset.set(time * 0.004, time * 0.0025);
  }
}
