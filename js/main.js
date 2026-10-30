import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  world, setTerrainData, BASE_RELIEF, SEABED_COMPRESS, V_SCALE, project, groundY,
} from './projection.js';
import { buildEnvironment, buildBackground, buildContactShadow, SUN_DIR } from './environment.js';
import { Terrain, MAX_WAVES } from './terrain.js';
import { Quakes, MS_PER_YEAR, depthColor } from './quakes.js';
import { Overlays, buildFaults } from './overlays.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Notable events (matched against the catalogue by date + magnitude window)
// ---------------------------------------------------------------------------
const NOTABLE = [
  { d: '1912-08-09', min: 7.0, name: 'Ganos–Mürefte' },
  { d: '1939-12-26', min: 7.5, name: 'Erzincan' },
  { d: '1943-11-26', min: 7.3, name: 'Tosya–Ladik' },
  { d: '1944-02-01', min: 7.4, name: 'Bolu–Gerede' },
  { d: '1953-03-18', min: 7.0, name: 'Yenice–Gönen' },
  { d: '1967-07-22', min: 7.0, name: 'Mudurnu Valley' },
  { d: '1970-03-28', min: 7.0, name: 'Gediz' },
  { d: '1976-11-24', min: 7.0, name: 'Çaldıran' },
  { d: '1999-08-17', min: 7.4, name: 'İzmit (Kocaeli)' },
  { d: '1999-11-12', min: 7.0, name: 'Düzce' },
  { d: '2011-10-23', min: 7.0, name: 'Van' },
  { d: '2023-02-06', min: 7.7, name: 'Pazarcık · Kahramanmaraş' },
  { d: '2023-02-06', min: 7.4, max: 7.6, name: 'Elbistan' },
];

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

const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.5, 1500);
const HOME_SURFACE = { pos: new THREE.Vector3(2, 76, 96), target: new THREE.Vector3(0, -2, 3) };
const HOME_DEPTH = { pos: new THREE.Vector3(8, 40, 112), target: new THREE.Vector3(0, -7, 3) };
const HOME = HOME_SURFACE;
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
// Loading
// ---------------------------------------------------------------------------
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

reportProgress('Loading terrain…');
const meta = await fetchJSON('data/terrain_meta.json');
progress.meta = 1; reportProgress();
const [heights, albedo, rawQuakes, faultSegments] = await Promise.all([
  fetchHeights('data/terrain_h.png', 'heights', meta),
  loadTexture('data/terrain_albedo.jpg').then((t) => { progress.albedo = 1; reportProgress('Shading relief…'); return t; }),
  fetchJSON('data/earthquakes.json'),
  fetchJSON('data/faults.json').then((f) => { progress.data = 1; reportProgress(); return f; }),
]);

setTerrainData(meta, heights);

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

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
reportProgress('Building the 3D map…');
await new Promise((r) => setTimeout(r, 30));

const terrain = new Terrain({ scene, albedo, albedoPixels, maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
const overlays = new Overlays(scene);
const faultUniforms = { uFlow: { value: 0 } };
let faultMesh = null;
function rebuildFaults() {
  if (faultMesh) { scene.remove(faultMesh); faultMesh.geometry.dispose(); faultMesh.material.dispose(); }
  faultMesh = buildFaults(faultSegments, faultUniforms);
  scene.add(faultMesh);
}
rebuildFaults();

const quakeData = rawQuakes
  .map((q) => ({ ...q, ms: Date.parse(q.t) }))
  .filter((q) => !Number.isNaN(q.ms))
  .sort((a, b) => a.ms - b.ms);
const quakes = new Quakes({ scene, quakes: quakeData });
const N = quakes.N;
const minMs = quakes.minMs, maxMs = quakes.maxMs;

const contact = buildContactShadow(world.extent.xMax - world.extent.xMin, world.extent.zMax - world.extent.zMin, world.baseY - 0.4);
scene.add(contact);

// Notable events resolved against the catalogue.
const notable = NOTABLE.map((n) => {
  let best = -1;
  for (let i = 0; i < N; i++) {
    const q = quakeData[i];
    if (q.t.startsWith(n.d) && q.mag >= n.min && q.mag <= (n.max ?? 99) && (best < 0 || q.mag > quakeData[best].mag)) best = i;
  }
  return best < 0 ? null : { ...n, i: best, q: quakeData[best], shownAt: -1e9, obj: null };
}).filter(Boolean);

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
buildCallouts();

// ---------------------------------------------------------------------------
// State + UI
// ---------------------------------------------------------------------------
const state = {
  ms: minMs, playing: false, speed: 2, depthTarget: 1, depthMix: 1,
  revealed: 0, prevRevealed: 0, relief: 1,
};
const slider = $('time-slider');
const SLIDER_RES = 10000;
const playIcon = $('play-icon');
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M7 5h4v14H7zM13 5h4v14h-4z';

const msToSlider = (ms) => Math.round(((ms - minMs) / (maxMs - minMs)) * SLIDER_RES);
const sliderToMs = (v) => minMs + (v / SLIDER_RES) * (maxMs - minMs);
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function setPlaying(on) {
  state.playing = on;
  playIcon.setAttribute('d', on ? PAUSE_PATH : PLAY_PATH);
}

// Shockwave rings draped on the terrain.
let waves = [];
const WAVE_MIN_MAG = 4.7;
function spawnWaves(from, to, nowSec) {
  const start = Math.max(from, to - 60);
  for (let i = start; i < to; i++) {
    const q = quakeData[i];
    if (q.mag < WAVE_MIN_MAG) continue;
    const c = depthColor(q.depth);
    const big = q.mag - WAVE_MIN_MAG;
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

let homeTween = null;
function flyTo(preset) {
  const f = framed(preset);
  homeTween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: f.pos, tt: f.target };
}
function flyHome() { flyTo(state.depthTarget ? HOME_DEPTH : HOME_SURFACE); }
$('reset-view').addEventListener('click', flyHome);
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); $('play-btn').click(); }
  else if (e.key === 'd' || e.key === 'D') setView(state.depthTarget ? 'surface' : 'depth');
  else if (e.key === 'r' || e.key === 'R') flyHome();
  else if (e.key === 'l' || e.key === 'L') { const c = $('labels-checkbox'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
});

// ---------------------------------------------------------------------------
// Timeline sparkline: strongest event per year
// ---------------------------------------------------------------------------
const spark = $('spark');
const y0 = new Date(minMs).getUTCFullYear();
const y1 = new Date(maxMs).getUTCFullYear();
const yearMax = new Float32Array(y1 - y0 + 1);
for (const q of quakeData) {
  const y = new Date(q.ms).getUTCFullYear() - y0;
  if (q.mag > yearMax[y]) yearMax[y] = q.mag;
}
const decades = $('decades');
decades.style.position = 'relative';
decades.style.height = '14px';
for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) {
  const s = document.createElement('span');
  s.textContent = y;
  s.style.cssText = `position:absolute;transform:translateX(-50%);left:${((Date.UTC(y, 0, 1) - minMs) / (maxMs - minMs)) * 100}%`;
  decades.appendChild(s);
}
function magColor(m) {
  if (m >= 7) return '#b0102a';
  if (m >= 6) return '#e5453a';
  if (m >= 5) return '#f08a2c';
  return '#9fb1bf';
}
function drawSpark() {
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
    const bh = Math.max(2, ((m - 3.4) / (8.0 - 3.4)) * (h - 8));
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
    <small>${Math.round(q.depth)} km deep · ${q.lat.toFixed(2)}°N ${q.lon.toFixed(2)}°E</small><small>${q.place || ''}</small>`;
  tooltip.style.left = `${ptr.x}px`;
  tooltip.style.top = `${ptr.y}px`;
  tooltip.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
applyTime(minMs);
quakes.setDepthMix(1);
terrain.setXray(1);
// Compile shaders and upload textures behind the loader so the reveal is smooth.
// (`?fast` skips the wait; handy for automated screenshots in throttled tabs.)
if (!location.search.includes('fast')) {
  reportProgress('Compiling shaders…');
  loaderBar.style.width = '97%';
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
    // rAF can be throttled in background tabs; never let that block the reveal.
  await Promise.race([new Promise((r) => requestAnimationFrame(r)), new Promise((r) => setTimeout(r, 300))]);
}
loaderBar.style.width = '100%';
$('loader').classList.add('done');
if (location.search.includes('fast')) $('loader').style.display = 'none';

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
let intro = { t: 0, dur: 2.6, p0: camera.position.clone(), p1: framed(HOME_DEPTH).pos };
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
window.__atlas = { state, quakes, terrain, overlays, labelRenderer, camera, controls, scene, renderer, applyTime, setView, setPlaying, HOME: HOME_SURFACE, skipTweens() { if (intro) intro.t = 1; if (homeTween) homeTween.t = 1; } };
