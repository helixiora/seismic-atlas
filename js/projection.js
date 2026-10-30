import * as THREE from 'three';

// Equirectangular projection centred on the active region, longitude scaled by
// cos(lat) so horizontal distances are roughly to scale. 1 scene unit = 15 km.
export const KM_LAT = 111.0;
export const H_SCALE = 1 / 15;   // scene units per km, horizontal
export const V_SCALE = 1 / 5.5;  // scene units per km of hypocentre depth (~2.7x exaggerated)
export const BASE_RELIEF = 0.0012; // scene units per metre of elevation (~18x exaggerated)
export const SEABED_COMPRESS = 0.3; // bathymetry is drawn at 30% of land relief so the sea floor stays calm
export const MAX_DEPTH_KM = 200;

export const world = {
  refLon: 35.0,
  refLat: 39.0,
  kmLon: 111.0 * Math.cos(39.0 * Math.PI / 180), // km per degree of longitude at refLat
  relief: BASE_RELIEF,
  meta: null,
  heights: null, // Float32Array, row 0 = south, metres
  extent: null,
  baseY: -MAX_DEPTH_KM * V_SCALE,
};

export const lonToX = (lon) => (lon - world.refLon) * world.kmLon * H_SCALE;
export const latToZ = (lat) => -(lat - world.refLat) * KM_LAT * H_SCALE; // north = -z
export const xToLon = (x) => world.refLon + x / (world.kmLon * H_SCALE);
export const zToLat = (z) => world.refLat - z / (KM_LAT * H_SCALE);

// Switch the world to a new region: `ref` is the [lon, lat] the map is centred on.
export function setTerrainData(meta, heights, ref) {
  world.meta = meta;
  world.heights = heights;
  world.refLon = ref ? ref[0] : (meta.lonMin + meta.lonMax) / 2;
  world.refLat = ref ? ref[1] : (meta.latMin + meta.latMax) / 2;
  world.kmLon = 111.0 * Math.cos(world.refLat * Math.PI / 180);
  world.extent = {
    xMin: lonToX(meta.lonMin), xMax: lonToX(meta.lonMax),
    zMin: latToZ(meta.latMax), zMax: latToZ(meta.latMin),
  };
}

export function heightM(lon, lat) {
  const { w, h, lonMin, lonMax, latMin, latMax } = world.meta;
  const hs = world.heights;
  const fx = THREE.MathUtils.clamp((lon - lonMin) / (lonMax - lonMin), 0, 1) * (w - 1);
  const fy = THREE.MathUtils.clamp((lat - latMin) / (latMax - latMin), 0, 1) * (h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  const a = hs[y0 * w + x0], b = hs[y0 * w + x1], c = hs[y1 * w + x0], d = hs[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export const groundY = (lon, lat) => heightM(lon, lat) * world.relief;

// Surface elevation in scene units at a scene-space (x, z).
export const groundYAtXZ = (x, z) => groundY(xToLon(x), zToLat(z));

// Ground-following projection: hypocentres dig `depthKm` below the local surface.
export function project(lon, lat, depthKm = 0) {
  return new THREE.Vector3(
    lonToX(lon),
    groundY(lon, lat) - Math.max(depthKm, 0) * V_SCALE,
    latToZ(lat),
  );
}

// A point just above the surface, for things draped on the terrain.
export function groundPoint(lon, lat, extra = 0, floorAtSea = false) {
  let y = groundY(lon, lat);
  if (floorAtSea) y = Math.max(y, 0);
  return new THREE.Vector3(lonToX(lon), y + extra, latToZ(lat));
}
