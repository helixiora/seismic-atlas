import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  world, lonToX, latToZ, groundY, groundPoint, groundYAtXZ, V_SCALE,
} from './projection.js';

// 12°W / 140°E style labels.
export const fmtLon = (lon) => `${Math.abs(lon)}°${lon < 0 ? 'W' : 'E'}`;
export const fmtLat = (lat) => `${Math.abs(lat)}°${lat < 0 ? 'S' : 'N'}`;

function label(text, cls, sub) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.innerHTML = sub ? `<span>${text}</span><em>${sub}</em>` : `<span>${text}</span>`;
  return new CSS2DObject(el);
}

// ---------------------------------------------------------------------------
// Faults: terrain-draped tubes with a gentle flowing highlight.
// ---------------------------------------------------------------------------
const FAULT_VERT_HEAD = /* glsl */`
attribute float aS;
varying float vS;
`;

export function buildFaults(faultSegments, uniforms) {
  const geoms = [];
  const cLow = new THREE.Color('#e09a52');
  const cHigh = new THREE.Color('#b0102a');
  const tmp = new THREE.Color();

  for (const seg of faultSegments) {
    if (seg.coords.length < 2) continue;
    const sys = seg.system || 'other';
    const main = sys !== 'other';
    const rate = sys === 'EAF' ? Math.max(seg.rate ?? 0, 9) : (seg.rate ?? 2);
    const t = THREE.MathUtils.clamp(rate / 25, 0, 1);
    const radius = main ? 0.20 + t * 0.07 : 0.07 + t * 0.09;

    // Densify in lon/lat so the tube follows the terrain between vertices.
    const pts = [];
    for (let k = 0; k < seg.coords.length - 1; k++) {
      const [lo0, la0] = seg.coords[k];
      const [lo1, la1] = seg.coords[k + 1];
      const len = Math.hypot(lonToX(lo1) - lonToX(lo0), latToZ(la1) - latToZ(la0));
      const n = Math.max(1, Math.ceil(len / 0.28));
      for (let s = 0; s < n; s++) {
        const f = s / n;
        pts.push(groundPoint(lo0 + (lo1 - lo0) * f, la0 + (la1 - la0) * f, radius * 0.9 + 0.04));
      }
    }
    const [loE, laE] = seg.coords[seg.coords.length - 1];
    pts.push(groundPoint(loE, laE, radius * 0.9 + 0.04));
    if (pts.length < 3) continue;

    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const length = curve.getLength();
    const g = new THREE.TubeGeometry(curve, Math.max(6, pts.length), radius, 6, false);
    tmp.copy(cLow).lerp(cHigh, Math.pow(t, 0.8));
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    const aS = new Float32Array(count);
    const uv = g.attributes.uv;
    for (let v = 0; v < count; v++) {
      col[v * 3] = tmp.r; col[v * 3 + 1] = tmp.g; col[v * 3 + 2] = tmp.b;
      aS[v] = uv.getX(v) * length;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    geoms.push(g);
  }

  const merged = mergeGeometries(geoms, false);
  geoms.forEach((g) => g.dispose());
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.42, metalness: 0.05, envMapIntensity: 0.9,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlow = uniforms.uFlow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FAULT_VERT_HEAD}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvS = aS;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vS;\nuniform float uFlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float flow = 0.5 + 0.5 * sin(vS * 1.35 - uFlow * 2.6);
        totalEmissiveRadiance += vColor * (0.10 + 0.62 * flow * flow * flow);`);
  };
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Labels, pins, graticule, depth ruler
// ---------------------------------------------------------------------------
export class Overlays {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.labels = [];       // { obj, kind, pos }
    this.region = null;
    this.viewScale = 1;     // camera distance scale of the region (bigger maps are viewed from further away)
  }

  setRegion(region, viewScale = 1) {
    this.region = region;
    this.viewScale = viewScale;
    this.build();
  }

  clear() {
    for (const l of this.labels) l.obj.element.remove();
    this.labels = [];
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    }
  }

  add(obj, kind, pos, rank = 1) {
    this.group.add(obj);
    this.labels.push({ obj, kind, pos: pos.clone(), rank });
  }

  build() {
    this.clear();
    if (!this.region) return;
    const { cities = [], seas = [], faultNames = [] } = this.region;
    const { xMin, xMax, zMin, zMax } = world.extent;
    const { lonMin, lonMax, latMin, latMax } = world.meta;

    // City pins with leader lines.
    const pinMat = new THREE.MeshStandardMaterial({ color: 0x24313a, roughness: 0.5 });
    const lineMat = new THREE.LineBasicMaterial({ color: 0x24313a, transparent: true, opacity: 0.55, toneMapped: false });
    for (const c of cities) {
      const base = groundPoint(c.lon, c.lat, 0.05);
      const topY = base.y + (c.rank === 1 ? 2.6 : 1.9);
      const pin = new THREE.Mesh(new THREE.SphereGeometry(c.rank === 1 ? 0.3 : 0.22, 14, 10), pinMat);
      pin.position.copy(base);
      this.group.add(pin);
      const lg = new THREE.BufferGeometry().setFromPoints([base, new THREE.Vector3(base.x, topY, base.z)]);
      this.group.add(new THREE.Line(lg, lineMat));
      const l = label(c.name, `city rank${c.rank}`, c.sub);
      l.position.set(base.x, topY + 0.1, base.z);
      this.add(l, 'city', l.position, c.rank);
    }

    for (const s of seas) {
      const l = label(s.name.toUpperCase(), s.small ? 'sea small' : 'sea');
      const p = new THREE.Vector3(lonToX(s.lon), 0.4, latToZ(s.lat));
      l.position.copy(p);
      this.add(l, 'sea', p);
    }
    for (const f of faultNames) {
      const l = label(f.name, 'faultname');
      const p = groundPoint(f.lon, f.lat, 1.4, true);
      l.position.copy(p);
      this.add(l, 'fault', p);
    }

    // Graticule draped over the terrain, every 1 degree (major every 5).
    const gratPts = { minor: [], major: [] };
    const addLine = (bucket, pts) => {
      for (let k = 0; k < pts.length - 1; k++) bucket.push(pts[k], pts[k + 1]);
    };
    const drape = (lon, lat) => {
      const v = groundPoint(lon, lat, 0.05);
      v.y = Math.max(v.y, 0.0) + 0.05;
      return v;
    };
    for (let lon = Math.ceil(lonMin); lon <= lonMax; lon++) {
      const pts = [];
      for (let lat = latMin; lat <= latMax + 1e-6; lat += 0.1) pts.push(drape(lon, lat));
      addLine(lon % 5 === 0 ? gratPts.major : gratPts.minor, pts);
      if (lon % 5 === 0) {
        const l = label(fmtLon(lon), 'tick');
        const p = new THREE.Vector3(lonToX(lon), 0, zMax + 2.4);
        l.position.copy(p);
        this.add(l, 'tick', p);
      }
    }
    for (let lat = Math.ceil(latMin); lat <= latMax; lat++) {
      const pts = [];
      for (let lon = lonMin; lon <= lonMax + 1e-6; lon += 0.1) pts.push(drape(lon, lat));
      addLine(lat % 5 === 0 ? gratPts.major : gratPts.minor, pts);
      const l = label(fmtLat(lat), 'tick');
      const p = new THREE.Vector3(xMin - 2.6, 0, latToZ(lat));
      l.position.copy(p);
      this.add(l, 'tick', p);
    }
    this.graticule = new THREE.Group();
    for (const [key, opacity] of [['minor', 0.10], ['major', 0.2]]) {
      const g = new THREE.BufferGeometry().setFromPoints(gratPts[key]);
      this.graticule.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0x1e2b36, transparent: true, opacity, toneMapped: false, depthWrite: false,
      })));
    }
    this.group.add(this.graticule);

    // Depth ruler at the front-left corner of the block.
    const rx = xMin - 0.9, rz = zMax + 0.9;
    const base = world.baseY;
    const rulerPts = [new THREE.Vector3(rx, 0, rz), new THREE.Vector3(rx, base, rz)];
    const rulerMat = new THREE.LineBasicMaterial({ color: 0x4a5a66, transparent: true, opacity: 0.8, toneMapped: false });
    this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rulerPts), rulerMat));
    const ticks = [];
    for (let km = 0; km <= 200; km += 10) {
      const y = -km * V_SCALE;
      const len = km % 50 === 0 ? 0.9 : 0.4;
      ticks.push(new THREE.Vector3(rx, y, rz), new THREE.Vector3(rx + len, y, rz));
      if (km % 50 === 0) {
        const l = label(km === 0 ? 'sea level' : `${km} km`, 'tick depth');
        const p = new THREE.Vector3(rx - 0.4, y, rz);
        l.position.copy(p);
        this.add(l, 'depth', p);
      }
    }
    this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), rulerMat));
  }

  setKindVisible(kind, on) {
    for (const l of this.labels) if (l.kind === kind) l.obj.visible = on;
  }

  // Fade labels that sit behind terrain relative to the camera.
  updateOcclusion(camera) {
    const ray = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const l of this.labels) {
      if (!l.obj.visible) continue;
      if (l.kind === 'tick' || l.kind === 'depth') { l.obj.element.style.opacity = ''; continue; }
      const target = l.pos;
      ray.copy(target).sub(camera.position);
      const dist = ray.length();
      ray.divideScalar(dist);
      let hidden = false;
      const steps = 40;
      for (let s = 1; s < steps; s++) {
        p.copy(camera.position).addScaledVector(ray, (dist * s) / steps);
        if (p.x < world.extent.xMin || p.x > world.extent.xMax || p.z < world.extent.zMin || p.z > world.extent.zMax) continue;
        if (groundYAtXZ(p.x, p.z) > p.y + 0.3 && p.y > -0.2) { hidden = true; break; }
      }
      const d = camera.position.distanceTo(target) / this.viewScale;
      const lod = l.kind !== 'city' ? 1 : l.rank === 1 ? 1 : l.rank === 2 ? THREE.MathUtils.clamp((205 - d) / 30, 0, 1) : THREE.MathUtils.clamp((150 - d) / 30, 0, 1);
      l.obj.element.style.opacity = hidden ? '0' : lod >= 1 ? '' : lod.toFixed(2);
    }
  }
}

export { groundY };
