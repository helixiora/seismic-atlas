import * as THREE from 'three';

// Equirectangular projection centred on Anatolia, longitude scaled by cos(lat)
// so horizontal distances are roughly to scale. 1 scene unit = 15 km.
export const REF_LON = 35.0;
export const REF_LAT = 39.0;
export const KM_LAT = 111.0;
export const KM_LON = 111.0 * Math.cos(REF_LAT * Math.PI / 180);
export const H_SCALE = 1 / 15;   // scene units per km, horizontal
export const V_SCALE = 1 / 5.5;  // scene units per km of hypocentre depth (~2.7x exaggerated)
export const BASE_RELIEF = 0.0012; // scene units per metre of elevation (~18x exaggerated)
export const SEABED_COMPRESS = 0.3; // bathymetry is drawn at 30% of land relief so the sea floor stays calm
export const MAX_DEPTH_KM = 200;

export const world = {
  relief: BASE_RELIEF,
  meta: null,
  heights: null, // Float32Array, row 0 = south, metres
  extent: null,
  baseY: -MAX_DEPTH_KM * V_SCALE,
};

export const lonToX = (lon) => (lon - REF_LON) * KM_LON * H_SCALE;
export const latToZ = (lat) => -(lat - REF_LAT) * KM_LAT * H_SCALE; // north = -z
export const xToLon = (x) => REF_LON + x / (KM_LON * H_SCALE);
export const zToLat = (z) => REF_LAT - z / (KM_LAT * H_SCALE);

export function setTerrainData(meta, heights) {
  world.meta = meta;
  world.heights = heights;
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
