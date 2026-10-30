"""LEGACY (Türkiye only): superseded by tools/build_region.py, which builds any region in
webapp/data/regions.json. Kept because it produced the shipped Türkiye terrain.

Build high-resolution terrain assets for the webapp.

Downloads AWS Terrarium elevation tiles (SRTM + bathymetry, public), resamples
them to an equirectangular grid, and bakes a cartographic albedo texture.

Outputs (in webapp/data):
  terrain_h.png       elevation in metres packed into R/G (see below), north-up
  terrain_meta.json   grid size + bounding box
  terrain_albedo.jpg  baked colour (hypsometric tint, vegetation, snow, sea depth)
"""
import io, json, math, os, sys
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen, Request

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

LON_MIN, LON_MAX = 25.0, 45.0
LAT_MIN, LAT_MAX = 35.0, 42.5
W, H = 3200, 1200
Z = 8
CACHE = os.environ.get("TILE_CACHE", "/tmp/terrarium_cache")
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "webapp")
if not os.path.isdir(SITE):  # flat layout (the GitHub repo): the site is the repo root
    SITE = os.path.join(HERE, "..")
OUT = os.path.join(SITE, "data", "turkey")
os.makedirs(CACHE, exist_ok=True)


def lon2x(lon, z):
    return (lon + 180.0) / 360.0 * (2 ** z)


def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (2 ** z)


def fetch(tx, ty):
    path = os.path.join(CACHE, f"{Z}_{tx}_{ty}.png")
    if not os.path.exists(path):
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png"
        for attempt in range(4):
            try:
                with urlopen(Request(url, headers={"User-Agent": "quake-viz"}), timeout=30) as r:
                    data = r.read()
                open(path, "wb").write(data)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    raise
    return np.array(Image.open(path).convert("RGB"), dtype=np.float32)


def main():
    pad = 0.15
    x0 = int(math.floor(lon2x(LON_MIN - pad, Z)))
    x1 = int(math.floor(lon2x(LON_MAX + pad, Z)))
    y0 = int(math.floor(lat2y(LAT_MAX + pad, Z)))
    y1 = int(math.floor(lat2y(LAT_MIN - pad, Z)))
    print("tiles x", x0, x1, "y", y0, y1, "count", (x1 - x0 + 1) * (y1 - y0 + 1))
    coords = [(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
    with ThreadPoolExecutor(12) as ex:
        tiles = dict(zip(coords, ex.map(lambda c: fetch(*c), coords)))

    mw, mh = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    merc = np.zeros((mh, mw), np.float32)
    for (tx, ty), t in tiles.items():
        merc[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = \
            t[..., 0] * 256 + t[..., 1] + t[..., 2] / 256 - 32768

    # Resample mercator -> equirectangular (row 0 = south).
    lons = LON_MIN + (LON_MAX - LON_MIN) * np.arange(W) / (W - 1)
    lats = LAT_MIN + (LAT_MAX - LAT_MIN) * np.arange(H) / (H - 1)
    px = (lon2x(lons, Z) - x0) * 256
    py = np.array([(lat2y(l, Z) - y0) * 256 for l in lats])
    gx, gy = np.meshgrid(px, py)
    elev = ndi.map_coordinates(merc, [gy, gx], order=1, mode="nearest").astype(np.float32)
    # Light smoothing tames SRTM speckle at this exaggeration (keeps coastlines crisp).
    elev = ndi.gaussian_filter(elev, 0.8)
    print("elev min/max", elev.min(), elev.max())

    os.makedirs(OUT, exist_ok=True)
    # Elevation in metres, lossless in a PNG: R = high byte, G = low byte of (metres + 8192).
    enc = (elev.round().astype(np.int32) + 8192).clip(0, 65535)
    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[..., 0] = enc >> 8
    rgb[..., 1] = enc & 255
    Image.fromarray(rgb[::-1]).save(os.path.join(OUT, "terrain_h.png"), optimize=True)  # row 0 = north in the file
    json.dump({"w": W, "h": H, "lonMin": LON_MIN, "lonMax": LON_MAX,
               "latMin": LAT_MIN, "latMax": LAT_MAX},
              open(os.path.join(OUT, "terrain_meta.json"), "w"))

    bake_albedo(elev, lats)


def ramp(values, stops):
    xs = np.array([s[0] for s in stops], np.float32)
    cs = np.array([s[1] for s in stops], np.float32)
    out = np.empty(values.shape + (3,), np.float32)
    for k in range(3):
        out[..., k] = np.interp(values, xs, cs[:, k])
    return out


def bake_albedo(elev, lats):
    rng = np.random.default_rng(7)
    land = elev > 0
    # Smooth elevation for slope / cavity measures (pixel ~ 0.6 km).
    sm = ndi.gaussian_filter(elev, 1.2)
    gy_, gx_ = np.gradient(sm)
    px_km_x = (LON_MAX - LON_MIN) / (W - 1) * 111.0 * np.cos(np.radians(lats))[:, None]
    px_km_y = (LAT_MAX - LAT_MIN) / (H - 1) * 111.0
    slope = np.hypot(gx_ / (px_km_x * 1000), gy_ / (px_km_y * 1000))  # rise/run
    slope_deg = np.degrees(np.arctan(slope))

    # Vegetation: wetter near the sea (esp. Black Sea / Mediterranean belts),
    # drier on the interior plateau, nothing above the tree line.
    sea_prox = ndi.gaussian_filter((~land).astype(np.float32), 55)
    wet = np.clip(sea_prox * 2.1, 0, 1)
    lat_grid = np.broadcast_to(lats[:, None], elev.shape)
    wet = np.clip(wet + np.clip((lat_grid - 40.2) * 0.25, 0, 0.35), 0, 1)
    veg = wet * np.clip(1 - (elev - 1400) / 1500, 0, 1)

    dry = ramp(elev, [
        (0, (200, 205, 158)), (300, (216, 208, 152)), (800, (226, 208, 156)),
        (1300, (222, 200, 152)), (1800, (205, 182, 142)), (2400, (184, 160, 132)),
        (3000, (172, 156, 140)), (3600, (214, 208, 202)), (4200, (244, 244, 246)),
        (5200, (255, 255, 255))])
    green = ramp(elev, [
        (0, (150, 182, 118)), (400, (140, 172, 112)), (1000, (150, 170, 114)),
        (1600, (172, 180, 128)), (2200, (190, 184, 140)), (4000, (214, 208, 202))])
    col = dry * (1 - veg[..., None] * 0.75) + green * (veg[..., None] * 0.75)

    # Rock on steep slopes, snow above the snow line (a bit lower on steeper-free ground).
    rock = np.clip((slope_deg - 9) / 22, 0, 1)[..., None]
    col = col * (1 - rock * 0.55) + np.array([150, 138, 126], np.float32) * rock * 0.55
    snow = np.clip((elev - 3000) / 700, 0, 1) * np.clip(1.15 - slope_deg / 45, 0.25, 1)
    col = col * (1 - snow[..., None]) + np.array([248, 249, 251], np.float32) * snow[..., None]

    # Cavity / ridge shading baked in softly (valleys darker, ridges lighter).
    cav = sm - ndi.gaussian_filter(sm, 9)
    cav = np.clip(cav / 260.0, -1, 1)
    col *= (1 + 0.10 * cav)[..., None]

    # Grain.
    grain = ndi.gaussian_filter(rng.normal(0, 1, elev.shape).astype(np.float32), 0.8)
    col *= (1 + 0.035 * grain / grain.std())[..., None]

    # Ocean by depth, bright shoreline shelf.
    depth = np.clip(-elev, 0, None)
    sea = ramp(depth, [
        (0, (186, 226, 226)), (25, (158, 212, 222)), (120, (118, 190, 214)),
        (500, (84, 156, 196)), (1500, (56, 122, 176)), (3000, (38, 92, 150)),
        (4500, (28, 70, 126))])
    sea_shade = 1 + 0.08 * np.clip(cav, -1, 1)[..., None]
    col = np.where(land[..., None], col, sea * sea_shade)

    # Soft land/sea transition.
    blend = np.clip((elev + 4) / 8, 0, 1)[..., None]
    shore = np.array([232, 226, 200], np.float32)
    ring = np.exp(-((elev - 1) / 6.0) ** 2)[..., None] * 0.55
    col = np.where(land[..., None], col * (1 - ring) + shore * ring, col)
    del blend

    img = np.clip(col, 0, 255).astype(np.uint8)[::-1]  # flip: image row 0 = north
    Image.fromarray(img).save(os.path.join(OUT, "terrain_albedo.jpg"), quality=93, subsampling=0)
    print("albedo saved", img.shape)


if __name__ == "__main__":
    main()
