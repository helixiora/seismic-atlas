import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  world, setTerrainData, BASE_RELIEF, SEABED_COMPRESS, project,
} from './projection.js';
import { buildEnvironment, buildBackground, buildContactShadow, SUN_DIR } from './environment.js';
import { Terrain, MAX_WAVES } from './terrain.js';
import { Quakes, MS_PER_YEAR, depthColor, magRadius } from './quakes.js';
import { Overlays, buildFaults, fmtLon, fmtLat } from './overlays.js';

const $ = (id) => document.getElementById(id);
const FAST = location.search.includes('fast');

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const container = $('scene-container');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.14;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'fixed', top: '0', left: '0', pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = buildBackground();
scene.fog = new THREE.FogExp2(0xe9edef, 0.0016);
scene.environment = buildEnvironment(renderer);

const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.5, 2400);
// Camera presets are derived from the size of the active region (see frameRegion).
let HOME_SURFACE = { pos: new THREE.Vector3(2, 76, 96), target: new THREE.Vector3(0, -2, 3) };
let HOME_DEPTH = { pos: new THREE.Vector3(8, 40, 112), target: new THREE.Vector3(0, -7, 3) };
let viewScale = 1;
// Narrower windows need the camera further back to keep the whole map in frame.
function framed(preset) {
  const aspect = Math.max(window.innerWidth, 320) / Math.max(window.innerHeight, 240);
  const k = THREE.MathUtils.clamp(1.8 / aspect, 1, 2.3);
  return { pos: preset.target.clone().add(preset.pos.clone().sub(preset.target).multiplyScalar(k)), target: preset.target };
}
camera.position.set(0, 170, 300);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.copy(HOME_DEPTH.target);
controls.minDistance = 12;
controls.maxDistance = 520;
controls.maxPolarAngle = Math.PI * 0.62;
controls.zoomSpeed = 0.8;

updateViewOffset();

// Key light with soft shadows; the sky environment supplies ambient fill.
const sun = new THREE.DirectionalLight(0xfff1dc, 3.3);
sun.position.copy(SUN_DIR).multiplyScalar(180);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -92, right: 92, top: 72, bottom: -72, near: 20, far: 420 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.05;
sun.shadow.radius = 3;
scene.add(sun);
scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0xdfeaff, 0xcfc7b5, 0.32));

function updateViewOffset() {
  const w = window.innerWidth, h = window.innerHeight;
  const wide = w > 900;
  camera.setViewOffset(w, h, wide ? Math.min(46, w * 0.03) : 0, wide ? 30 : 10, w, h);
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  updateViewOffset();
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  drawSpark();
});

// ---------------------------------------------------------------------------
// Region-bound state (replaced whenever the region changes)
// ---------------------------------------------------------------------------
let REGIONS = {};
let regionId = null;
let region = null;
let terrain = null;
let quakes = null;
let faultMesh = null;
let contact = null;
let quakeData = [];
let notable = [];
let N = 0, minMs = 0, maxMs = 1;
let y0 = 0, y1 = 0, yearMax = new Float32Array(0);
let sparkMin = 3.4, sparkMax = 8.0;

const overlays = new Overlays(scene);
const faultUniforms = { uFlow: { value: 0 } };

const state = {
  ms: 0, playing: false, speed: 2, depthTarget: 1, depthMix: 1,
  revealed: 0, prevRevealed: 0, relief: 1,
};
let waves = [];
let intro = null;
let homeTween = null;
let switching = false;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const loader = $('loader');
const loaderBar = $('loader-bar');
const loaderText = $('loader-text');
const progress = { meta: 0, heights: 0, albedo: 0, data: 0 };
const WEIGHTS = { meta: 0.05, heights: 0.4, albedo: 0.35, data: 0.2 };
function reportProgress(text) {
  const p = Object.keys(progress).reduce((s, k) => s + progress[k] * WEIGHTS[k], 0);
  loaderBar.style.width = `${Math.round(p * 95)}%`;
  if (text) loaderText.textContent = text;
}

async function fetchJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url); return r.json(); }

// Elevation arrives as a lossless PNG: R/G hold (metres + 8192) as a 16-bit value, north-up.
async function fetchHeights(url, key, meta) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url);
  const blob = await res.blob();
  progress[key] = 0.6; reportProgress();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const { w, h } = meta;
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const src = (h - 1 - j) * w * 4; // file row 0 is north; ours is south
    for (let i = 0; i < w; i++) {
      const o = src + i * 4;
      const m = (px[o] << 8 | px[o + 1]) - 8192;
      out[j * w + i] = m < 0 ? m * SEABED_COMPRESS : m;
    }
  }
  progress[key] = 1; reportProgress();
  return out;
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, (e) => { progress.albedo = e.total ? e.loaded / e.total : 0.5; reportProgress(); }, reject);
  });
}

async function loadAssets(id) {
  for (const k of Object.keys(progress)) progress[k] = 0;
  const base = `data/${id}`;
  reportProgress(`Loading ${REGIONS[id].label}…`);
  const meta = await fetchJSON(`${base}/terrain_meta.json`);
  progress.meta = 1; reportProgress();
  const [heights, albedo, rawQuakes, faultSegments] = await Promise.all([
    fetchHeights(`${base}/terrain_h.png`, 'heights', meta),
    loadTexture(`${base}/terrain_albedo.jpg`).then((t) => { progress.albedo = 1; reportProgress('Shading relief…'); return t; }),
    fetchJSON(`${base}/earthquakes.json`),
    fetchJSON(`${base}/faults.json`).then((f) => { progress.data = 1; reportProgress(); return f; }),
  ]);
  return { meta, heights, albedo, rawQuakes, faultSegments };
}

// ---------------------------------------------------------------------------
// Building a region
// ---------------------------------------------------------------------------
function rebuildFaults() {
  if (faultMesh) { scene.remove(faultMesh); faultMesh.geometry.dispose(); faultMesh.material.dispose(); }
  faultMesh = buildFaults(faultSegments, faultUniforms);
  scene.add(faultMesh);
}
let faultSegments = [];

function buildCallouts() {
  for (const n of notable) {
    if (n.obj) scene.remove(n.obj);
    const el = document.createElement('div');
    el.className = 'lbl callout';
    el.innerHTML = `<span><b>M${n.q.mag.toFixed(1)}</b>${n.q.t.slice(0, 4)} ${n.name}</span>`;
    el.style.opacity = '0';
    const o = new CSS2DObject(el);
    const p = project(n.q.lon, n.q.lat, 0);
    o.position.set(p.x, p.y + 3.4, p.z);
    scene.add(o);
    n.obj = o;
  }
}

// Camera presets, shadow frustum and fog follow the size of the region.
// Constants are the Türkiye framing (115 x 55 units), scaled up for bigger maps.
function frameRegion() {
  const { xMin, xMax, zMin, zMax } = world.extent;
  const w = xMax - xMin, d = zMax - zMin;
  const cx = (xMin + xMax) / 2, cz = (zMin + zMax) / 2;
  viewScale = Math.max(w / 115, (d * 0.77 + 36) / 78);
  const s = viewScale;
  HOME_SURFACE = {
    target: new THREE.Vector3(cx, -2, cz + s),
    pos: new THREE.Vector3(cx + 2 * s, -2 + 78 * s, cz + s + 93 * s),
  };
  HOME_DEPTH = {
    target: new THREE.Vector3(cx, -7, cz + s),
    pos: new THREE.Vector3(cx + 8 * s, -7 + 47 * s, cz + s + 109 * s),
  };
  controls.maxDistance = 520 * s;
  scene.fog.density = 0.0016 / s;

  const half = 0.5 * Math.hypot(w, d) + 28;
  sun.target.position.set(cx, 0, cz);
  sun.position.copy(SUN_DIR).multiplyScalar(180).add(sun.target.position);
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half * 0.78, bottom: -half * 0.78 });
  sun.shadow.camera.updateProjectionMatrix();
}

function prepareTimeline() {
  y0 = new Date(minMs).getUTCFullYear();
  y1 = new Date(maxMs).getUTCFullYear();
  yearMax = new Float32Array(y1 - y0 + 1);
  let top = 0;
  for (const q of quakeData) {
    const y = new Date(q.ms).getUTCFullYear() - y0;
    if (q.mag > yearMax[y]) yearMax[y] = q.mag;
    top = Math.max(top, q.mag);
  }
  sparkMin = region.minMag - 0.1;
  sparkMax = Math.max(8.0, top + 0.2);
  const decades = $('decades');
  decades.replaceChildren();
  decades.style.position = 'relative';
  decades.style.height = '14px';
  for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) {
    const el = document.createElement('span');
    el.textContent = y;
    el.style.cssText = `position:absolute;transform:translateX(-50%);left:${((Date.UTC(y, 0, 1) - minMs) / (maxMs - minMs)) * 100}%`;
    decades.appendChild(el);
  }
}

const dotPx = (m) => Math.round(7 + (magRadius(m) - 0.22) * 9.9);

function renderRegionUI() {
  document.title = `${region.title} — Seismic Atlas`;
  $('brand-title').innerHTML = `${region.title} <span>Seismic Atlas</span>`;
  $('subtitle').textContent = `M ≥ ${region.minMag} earthquakes, ${y0} – ${y1} · USGS ANSS · SRTM relief & bathymetry`;
  $('mag-row').innerHTML = region.legend.mags
    .map((m) => `<span><i class="dot" style="--s:${dotPx(m)}px"></i>${m.toFixed(1)}</span>`).join('');
  $('fault-legend').textContent = region.legend.faults;
  $('region-note').textContent = region.note || '';
  $('region-note').hidden = !region.note;
  $('reset-btn').title = `Back to ${y0}`;
  for (const b of $('region-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.region === regionId);
}

function buildRegion(id, assets) {
  // Tear down the previous region.
  if (terrain) terrain.dispose();
  if (quakes) quakes.dispose();
  if (contact) { scene.remove(contact); contact.geometry.dispose(); contact.material.map.dispose(); contact.material.dispose(); }
  for (const n of notable) if (n.obj) scene.remove(n.obj);
  waves = [];

  regionId = id;
  region = REGIONS[id];
  const { meta, heights, albedo, rawQuakes } = assets;
  faultSegments = assets.faultSegments;
  setTerrainData(meta, heights, region.ref);
  world.relief = BASE_RELIEF * state.relief;

  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = renderer.capabilities.getMaxAnisotropy();
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.generateMipmaps = true;
  const albedoPixels = (() => {
    const img = albedo.image;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  })();

  terrain = new Terrain({ scene, albedo, albedoPixels, maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
  terrain.setXray(state.depthMix);
  frameRegion();
  overlays.setRegion(region, viewScale);
  rebuildFaults();

  quakeData = rawQuakes
    .map((q) => ({ ...q, ms: Date.parse(q.t) }))
    .filter((q) => !Number.isNaN(q.ms))
    .sort((a, b) => a.ms - b.ms);
  quakes = new Quakes({ scene, quakes: quakeData });
  quakes.setFade($('fade-checkbox').checked);
  quakes.setDepthMix(state.depthMix);
  N = quakes.N;
  minMs = quakes.minMs;
  maxMs = quakes.maxMs;

  contact = buildContactShadow(world.extent.xMax - world.extent.xMin, world.extent.zMax - world.extent.zMin, world.baseY - 0.4);
  contact.position.x = (world.extent.xMin + world.extent.xMax) / 2;
  contact.position.z = (world.extent.zMin + world.extent.zMax) / 2;
  scene.add(contact);

  // Notable events resolved against the catalogue (date + magnitude window).
  notable = (region.notable || []).map((n) => {
    let best = -1;
    for (let i = 0; i < N; i++) {
      const q = quakeData[i];
      if (q.t.startsWith(n.d) && q.mag >= n.min && q.mag <= (n.max ?? 99) && (best < 0 || q.mag > quakeData[best].mag)) best = i;
    }
    return best < 0 ? null : { ...n, i: best, q: quakeData[best], shownAt: -1e9, obj: null };
  }).filter(Boolean);
  buildCallouts();
  syncLabelVisibility();

  prepareTimeline();
  renderRegionUI();
  $('event-card').classList.add('hidden');
  applyTime(minMs);
}

// Camera swoops in from high above: used on first load and after every region change.
function startIntro() {
  const home = state.depthTarget ? HOME_DEPTH : HOME_SURFACE;
  const c = home.target;
  homeTween = null;
  controls.target.copy(c);
  intro = { t: 0, dur: 2.6, p0: new THREE.Vector3(c.x, 170 * viewScale, c.z + 300 * viewScale), p1: framed(home).pos };
  camera.position.copy(intro.p0);
}

// ---------------------------------------------------------------------------
// State + UI
// ---------------------------------------------------------------------------
const slider = $('time-slider');
const SLIDER_RES = 10000;
const playIcon = $('play-icon');
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M7 5h4v14H7zM13 5h4v14h-4z';

const msToSlider = (ms) => Math.round(((ms - minMs) / (maxMs - minMs)) * SLIDER_RES);
const sliderToMs = (v) => minMs + (v / SLIDER_RES) * (maxMs - minMs);
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;

function setPlaying(on) {
  state.playing = on;
  playIcon.setAttribute('d', on ? PAUSE_PATH : PLAY_PATH);
}

// Shockwave rings draped on the terrain.
function spawnWaves(from, to, nowSec) {
  const minMag = region.waveMinMag ?? 4.7;
  const start = Math.max(from, to - 60);
  for (let i = start; i < to; i++) {
    const q = quakeData[i];
    if (q.mag < minMag) continue;
    const c = depthColor(q.depth);
    const big = q.mag - minMag;
    waves.push({
      x: quakes.surface[i * 3], z: quakes.surface[i * 3 + 2], mag: q.mag, color: c,
      t0: nowSec, life: 2.2 + big * 0.5, maxR: 2.0 + big * 2.6, strength: Math.min(1, 0.55 + big * 0.12),
    });
  }
  if (waves.length > MAX_WAVES) {
    waves.sort((a, b) => b.mag - a.mag || b.t0 - a.t0);
    waves.length = MAX_WAVES;
  }
}

const card = $('event-card');
let cardTimer = 0;
function showNotable(n, nowSec) {
  n.shownAt = nowSec;
  const q = n.q;
  card.innerHTML = `<div class="ec-kicker">${q.t.slice(0, 4)} · major earthquake</div>
    <div class="ec-name">${n.name}</div>
    <div class="ec-meta"><div><b>M ${q.mag.toFixed(1)}</b><span>Magnitude</span></div>
    <div><b>${Math.round(q.depth)} km</b><span>Depth</span></div>
    <div><b>${fmtDate(q.ms).slice(5)}</b><span>${q.t.slice(0, 4)}</span></div></div>`;
  card.classList.remove('hidden');
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => card.classList.add('hidden'), 6500);
}

function applyTime(ms, { animate = false, nowSec = 0 } = {}) {
  const prev = state.ms;
  state.ms = THREE.MathUtils.clamp(ms, minMs, maxMs);
  quakes.setTime(state.ms);
  state.prevRevealed = state.revealed;
  state.revealed = quakes.countUpTo(state.ms);
  quakes.setRevealed(state.revealed);
  if (animate && state.revealed > state.prevRevealed) {
    spawnWaves(state.prevRevealed, state.revealed, nowSec);
    for (const n of notable) {
      if (n.q.ms > prev && n.q.ms <= state.ms && state.ms - n.q.ms < 3 * MS_PER_YEAR) showNotable(n, nowSec);
    }
  }
  slider.value = msToSlider(state.ms);
  $('date-readout').textContent = fmtDate(state.ms);
  $('event-count').textContent = `${state.revealed.toLocaleString()} / ${N.toLocaleString()} events`;
  drawSpark();
}

slider.addEventListener('input', () => {
  setPlaying(false);
  waves = [];
  applyTime(sliderToMs(Number(slider.value)));
});
$('play-btn').addEventListener('click', () => {
  if (!state.playing && state.ms >= maxMs) applyTime(minMs);
  setPlaying(!state.playing);
});
$('reset-btn').addEventListener('click', () => { setPlaying(false); waves = []; applyTime(minMs); });

for (const b of $('speed-seg').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    state.speed = Number(b.dataset.speed);
    for (const o of $('speed-seg').querySelectorAll('button')) o.classList.toggle('on', o === b);
  });
}
for (const b of $('view-seg').querySelectorAll('button')) {
  b.addEventListener('click', () => setView(b.dataset.view));
}
function setView(v, fly = true) {
  state.depthTarget = v === 'depth' ? 1 : 0;
  if (fly && !intro) flyTo(v === 'depth' ? HOME_DEPTH : HOME_SURFACE);
  for (const o of $('view-seg').querySelectorAll('button')) o.classList.toggle('on', o.dataset.view === v);
}
$('fade-checkbox').addEventListener('change', (e) => quakes.setFade(e.target.checked));
$('labels-checkbox').addEventListener('change', syncLabelVisibility);

const reliefSlider = $('relief-slider');
function syncLabelVisibility() {
  const on = $('labels-checkbox').checked;
  for (const k of ['city', 'sea', 'fault']) overlays.setKindVisible(k, on);
}
function rebuildOverlays() {
  overlays.build();
  rebuildFaults();
  quakes.updatePositions();
  buildCallouts();
  syncLabelVisibility();
}
let reliefTimer = 0;
reliefSlider.addEventListener('input', () => {
  state.relief = Number(reliefSlider.value);
  $('relief-out').textContent = `${state.relief.toFixed(1)}×`;
  terrain.setRelief(BASE_RELIEF * state.relief);
  clearTimeout(reliefTimer);
  reliefTimer = setTimeout(rebuildOverlays, 160);
});

function flyTo(preset) {
  const f = framed(preset);
  homeTween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: f.pos, tt: f.target };
}
function flyHome() { flyTo(state.depthTarget ? HOME_DEPTH : HOME_SURFACE); }
$('reset-view').addEventListener('click', flyHome);
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); $('play-btn').click(); }
  else if (e.key === 'd' || e.key === 'D') setView(state.depthTarget ? 'surface' : 'depth');
  else if (e.key === 'r' || e.key === 'R') flyHome();
  else if (e.key === 'l' || e.key === 'L') { const c = $('labels-checkbox'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
  else if (/^[1-9]$/.test(e.key)) { const id = Object.keys(REGIONS)[Number(e.key) - 1]; if (id) switchRegion(id); }
});

// ---------------------------------------------------------------------------
// Region switcher
// ---------------------------------------------------------------------------
const paint = () => Promise.race([
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  new Promise((r) => setTimeout(r, 120)),
]);

function updateUrl(id) {
  const u = new URL(location.href);
  u.searchParams.set('region', id);
  history.replaceState(null, '', u);
}

async function switchRegion(id) {
  if (switching || id === regionId || !REGIONS[id]) return;
  switching = true;
  const prev = regionId;
  for (const b of $('region-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.region === id);
  setPlaying(false);
  if (!FAST) {
    loader.classList.add('quick');
    loader.style.display = '';
    loader.classList.remove('done');
    loaderBar.style.width = '0%';
    reportProgress(`Loading ${REGIONS[id].label}…`);
    await paint();
  }
  try {
    const assets = await loadAssets(id);
    reportProgress('Building the 3D map…');
    await paint();
    buildRegion(id, assets);
    startIntro();
    updateUrl(id);
  } catch (err) {
    console.error(err);
    for (const b of $('region-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.region === prev);
  }
  loaderBar.style.width = '100%';
  loader.classList.add('done');
  switching = false;
}

// ---------------------------------------------------------------------------
// Timeline sparkline: strongest event per year
// ---------------------------------------------------------------------------
const spark = $('spark');
function magColor(m) {
  if (m >= 7) return '#b0102a';
  if (m >= 6) return '#e5453a';
  if (m >= 5) return '#f08a2c';
  return '#9fb1bf';
}
function drawSpark() {
  if (!yearMax.length) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = spark.clientWidth, h = spark.clientHeight;
  if (!w) return;
  if (spark.width !== Math.round(w * dpr)) { spark.width = Math.round(w * dpr); spark.height = Math.round(h * dpr); }
  const g = spark.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const prog = (state.ms - minMs) / (maxMs - minMs);
  const px = prog * w;
  // grid
  g.fillStyle = 'rgba(23,35,44,0.05)';
  g.fillRect(0, h - 1, w, 1);
  for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) {
    const x = ((Date.UTC(y, 0, 1) - minMs) / (maxMs - minMs)) * w;
    g.fillStyle = 'rgba(23,35,44,0.06)';
    g.fillRect(x, 0, 1, h);
  }
  // progress wash
  const wash = g.createLinearGradient(0, 0, 0, h);
  wash.addColorStop(0, 'rgba(214,50,43,0.0)');
  wash.addColorStop(1, 'rgba(214,50,43,0.10)');
  g.fillStyle = wash;
  g.fillRect(0, 0, px, h);
  // bars
  const bw = Math.max(1.5, (w / yearMax.length) * 0.62);
  for (let i = 0; i < yearMax.length; i++) {
    const m = yearMax[i];
    if (!m) continue;
    const x = ((Date.UTC(y0 + i, 6, 1) - minMs) / (maxMs - minMs)) * w;
    const bh = Math.max(2, ((m - sparkMin) / (sparkMax - sparkMin)) * (h - 8));
    g.globalAlpha = x <= px ? 1 : 0.28;
    g.fillStyle = magColor(m);
    g.beginPath();
    g.roundRect(x - bw / 2, h - bh, bw, bh, 1.2);
    g.fill();
  }
  g.globalAlpha = 1;
  // notable ticks
  for (const n of notable) {
    const x = ((n.q.ms - minMs) / (maxMs - minMs)) * w;
    g.fillStyle = x <= px ? '#17232c' : 'rgba(23,35,44,0.3)';
    g.beginPath();
    g.arc(x, 4, 2.1, 0, Math.PI * 2);
    g.fill();
  }
  // playhead
  g.fillStyle = '#17232c';
  g.fillRect(px - 0.75, 0, 1.5, h);
  g.fillStyle = '#d6322b';
  g.beginPath();
  g.arc(px, h - 1, 4.5, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5;
  g.stroke();
}

// ---------------------------------------------------------------------------
// Hover tooltip
// ---------------------------------------------------------------------------
const tooltip = $('tooltip');
let ptr = { x: 0, y: 0, dirty: false, over: false };
renderer.domElement.addEventListener('pointermove', (e) => { ptr = { x: e.clientX, y: e.clientY, dirty: true, over: true }; });
renderer.domElement.addEventListener('pointerleave', () => { ptr.over = false; ptr.dirty = true; });
function updateTooltip() {
  if (!ptr.dirty) return;
  ptr.dirty = false;
  if (!ptr.over) { tooltip.classList.add('hidden'); return; }
  const i = quakes.pick(camera, ptr.x, ptr.y, window.innerWidth, window.innerHeight, state.revealed);
  if (i < 0) { tooltip.classList.add('hidden'); return; }
  const q = quakeData[i];
  tooltip.innerHTML = `<span class="tt-m">M ${q.mag.toFixed(1)}</span><b>${fmtDate(q.ms)}</b>
    <small>${Math.round(q.depth)} km deep · ${fmtCoord(q.lat, q.lon)}</small><small>${q.place || ''}</small>`;
  tooltip.style.left = `${ptr.x}px`;
  tooltip.style.top = `${ptr.y}px`;
  tooltip.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
reportProgress('Loading terrain…');
{
  const file = await fetchJSON('data/regions.json');
  REGIONS = file.regions;
  const want = new URLSearchParams(location.search).get('region') || location.hash.slice(1);
  const first = REGIONS[want] ? want : file.default;

  const seg = $('region-seg');
  for (const [id, r] of Object.entries(REGIONS)) {
    const b = document.createElement('button');
    b.dataset.region = id;
    b.textContent = r.label;
    b.addEventListener('click', () => switchRegion(id));
    seg.appendChild(b);
  }

  const assets = await loadAssets(first);
  reportProgress('Building the 3D map…');
  await new Promise((r) => setTimeout(r, 30));
  buildRegion(first, assets);
  startIntro();
}

// Compile shaders and upload textures behind the loader so the reveal is smooth.
// (`?fast` skips the wait; handy for automated screenshots in throttled tabs.)
if (!FAST) {
  reportProgress('Compiling shaders…');
  loaderBar.style.width = '97%';
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  // rAF can be throttled in background tabs; never let that block the reveal.
  await Promise.race([new Promise((r) => requestAnimationFrame(r)), new Promise((r) => setTimeout(r, 300))]);
}
loaderBar.style.width = '100%';
loader.classList.add('done');
if (FAST) loader.style.display = 'none';

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let frame = 0;
const maxDpr = Math.min(window.devicePixelRatio, 2);
let dpr = maxDpr;
let slowFrames = 0, fastFrames = 0;
function adaptResolution(dt) {
  // Ignore throttled/background frames; react only to genuinely slow rendering.
  if (dt > 0.25 || dt <= 0) return;
  if (dt > 1 / 34) { slowFrames++; fastFrames = 0; } else if (dt < 1 / 52) { fastFrames++; slowFrames = 0; } else { slowFrames = 0; fastFrames = 0; }
  if (slowFrames > 40 && dpr > 1) {
    dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); slowFrames = 0;
  } else if (fastFrames > 240 && dpr < maxDpr) {
    dpr = Math.min(maxDpr, dpr + 0.25); renderer.setPixelRatio(dpr); fastFrames = 0;
  }
}
const compass = $('compass-rose');
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const nowSec = clock.elapsedTime;
  frame++;
  adaptResolution(dt);

  if (intro) {
    intro.t += dt / intro.dur;
    const k = easeOut(Math.min(intro.t, 1));
    camera.position.lerpVectors(intro.p0, intro.p1, k);
    if (intro.t >= 1) intro = null;
  } else if (homeTween) {
    homeTween.t += dt / 1.1;
    const k = easeInOut(Math.min(homeTween.t, 1));
    camera.position.lerpVectors(homeTween.p0, homeTween.p1, k);
    controls.target.lerpVectors(homeTween.t0, homeTween.tt, k);
    if (homeTween.t >= 1) homeTween = null;
  }

  if (state.playing) {
    const next = state.ms + state.speed * MS_PER_YEAR * dt;
    if (next >= maxMs) { applyTime(maxMs, { animate: true, nowSec }); setPlaying(false); }
    else applyTime(next, { animate: true, nowSec });
  }

  // Surface <-> depth view blend.
  state.depthMix += (state.depthTarget - state.depthMix) * (1 - Math.exp(-dt * 4.5));
  if (Math.abs(state.depthTarget - state.depthMix) < 0.0008) state.depthMix = state.depthTarget;
  quakes.setDepthMix(state.depthMix);
  terrain.setXray(state.depthMix);

  waves = waves.filter((w) => nowSec - w.t0 < w.life);
  terrain.setWaves(waves, nowSec);
  terrain.update(nowSec);
  faultUniforms.uFlow.value = nowSec;

  // Callouts fade after a few seconds.
  for (const n of notable) {
    const age = nowSec - n.shownAt;
    const op = age < 0 ? 0 : age < 0.4 ? age / 0.4 : age < 8 ? 1 : Math.max(0, 1 - (age - 8) / 1.2);
    n.obj.element.style.opacity = op.toFixed(2);
  }

  updateTooltip();
  controls.update();
  compass.style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
  if (frame % 6 === 0 && $('labels-checkbox').checked) overlays.updateOcclusion(camera);

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();

// Debug / test hook.
window.__atlas = {
  state, labelRenderer, camera, controls, scene, renderer, overlays,
  get quakes() { return quakes; }, get terrain() { return terrain; }, get region() { return region; },
  get notable() { return notable; }, get HOME() { return HOME_SURFACE; },
  applyTime, setView, setPlaying, switchRegion,
  skipTweens() { if (intro) intro.t = 1; if (homeTween) homeTween.t = 1; },
};
