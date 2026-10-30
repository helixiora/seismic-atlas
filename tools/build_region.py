"""Build the data files for one region of the Seismic Atlas.

    python3 tools/build_region.py <region> [quakes] [faults] [terrain]

Reads data/regions.json and writes data/<region>/ (under webapp/ in the source tree):
  earthquakes.json    USGS ANSS ComCat events (t, lat, lon, depth, mag, place)
  faults.json         GEM Global Active Faults clipped to the region (coords, slip_type, rate, system, name)
  terrain_h.png       elevation in metres packed into R/G (see below), north-up
  terrain_meta.json   grid size + bounding box
  terrain_albedo.jpg  baked colour (hypsometric tint, vegetation, snow, sea depth)

Needs numpy, scipy and pillow. Tiles and the GEM download are cached in $TILE_CACHE
(default /tmp/terrarium_cache). Regions marked `"prebuilt": true` (Türkiye) are skipped
unless you name the step explicitly.
"""
import csv, io, json, math, os, re, sys
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from urllib.request import urlopen, Request

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "webapp")
if not os.path.isdir(SITE):  # flat layout (the GitHub repo): the site is the repo root
    SITE = os.path.join(HERE, "..")
DATA = os.path.join(SITE, "data")
CACHE = os.environ.get("TILE_CACHE", "/tmp/terrarium_cache")
os.makedirs(CACHE, exist_ok=True)
UA = {"User-Agent": "quake-viz"}
GEM_URL = "https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/master/geojson/gem_active_faults_harmonized.geojson"


def http(url, tries=4, timeout=60):
    for attempt in range(tries):
        try:
            with urlopen(Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception:  # noqa: BLE001
            if attempt == tries - 1:
                raise


# ---------------------------------------------------------------------------
# Earthquakes
# ---------------------------------------------------------------------------
def fetch_quakes(r, start, end):
    lon0, lon1, lat0, lat1 = r["bbox"]
    q = urlencode({
        "format": "csv", "eventtype": "earthquake", "orderby": "time-asc", "limit": 20000,
        "starttime": start, "endtime": end, "minmagnitude": r["minMag"],
        "minlatitude": lat0, "maxlatitude": lat1, "minlongitude": lon0, "maxlongitude": lon1,
    })
    text = http("https://earthquake.usgs.gov/fdsnws/event/1/query?" + q, timeout=120).decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))
    if len(rows) >= 20000:  # hit the API cap: split the window in half
        y0, y1 = int(start[:4]), int(end[:4])
        mid = f"{(y0 + y1) // 2}-01-01"
        if mid == start or mid == end:
            raise RuntimeError("cannot split window further " + start)
        return fetch_quakes(r, start, mid) + fetch_quakes(r, mid, end)
    return rows


def build_quakes(r, out):
    max_depth = r["build"].get("maxDepth", 200)
    years = list(range(1900, 2027, 5))
    with ThreadPoolExecutor(4) as ex:
        chunks = list(ex.map(lambda y: fetch_quakes(r, f"{y}-01-01", f"{y + 5}-01-01"), years))
    events, dropped = [], 0
    for rows in chunks:
        for row in rows:
            try:
                depth = max(float(row["depth"]), 0.0) if row["depth"] else 10.0
                mag = float(row["mag"])
            except ValueError:
                continue
            if depth > max_depth:
                dropped += 1
                continue
            events.append({
                "t": row["time"], "lat": round(float(row["latitude"]), 3), "lon": round(float(row["longitude"]), 3),
                "depth": round(depth, 1), "mag": mag, "place": row["place"],
            })
    events.sort(key=lambda e: e["t"])
    json.dump(events, open(os.path.join(out, "earthquakes.json"), "w"), separators=(",", ":"), ensure_ascii=False)
    print(f"earthquakes: {len(events)} kept, {dropped} deeper than {max_depth} km dropped")
    big = sorted(events, key=lambda e: -e["mag"])[:40]
    for e in big:
        print(f"  M{e['mag']:.1f} {e['t'][:10]} {e['depth']:.0f}km  {e['place']}")


# ---------------------------------------------------------------------------
# Faults
# ---------------------------------------------------------------------------
def parse_rate(props):
    m = re.match(r"\(\s*(-?[\d.]+)", props.get("net_slip_rate") or "")
    return float(m.group(1)) if m else None


def length_km(cs, ref_lat):
    k = math.cos(math.radians(ref_lat))
    return sum(math.hypot((b[0] - a[0]) * 111 * k, (b[1] - a[1]) * 111) for a, b in zip(cs, cs[1:]))


def clip_line(cs, bbox):
    """Clip a polyline to the bbox; returns a list of runs (Liang-Barsky per segment)."""
    x0, x1, y0, y1 = bbox
    runs, cur = [], []
    for a, b in zip(cs, cs[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t0, t1 = 0.0, 1.0
        ok = True
        for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dy, a[1] - y0), (dy, y1 - a[1])):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                t = q / p
                if p < 0:
                    t0 = max(t0, t)
                else:
                    t1 = min(t1, t)
        if not ok or t0 > t1:
            if len(cur) > 1:
                runs.append(cur)
            cur = []
            continue
        pa = [a[0] + dx * t0, a[1] + dy * t0]
        pb = [a[0] + dx * t1, a[1] + dy * t1]
        if cur and cur[-1] == pa:
            cur.append(pb)
        else:
            if len(cur) > 1:
                runs.append(cur)
            cur = [pa, pb]
    if len(cur) > 1:
        runs.append(cur)
    return runs


def chain_segments(segs, tol=0.03):
    """Join short two-point traces end-to-end into longer polylines."""
    key = lambda p: (round(p[0] / tol), round(p[1] / tol))  # noqa: E731
    ends = {}
    for i, s in enumerate(segs):
        for p in (s["coords"][0], s["coords"][-1]):
            ends.setdefault(key(p), []).append(i)
    used = [False] * len(segs)
    chains = []
    for i, s in enumerate(segs):
        if used[i]:
            continue
        used[i] = True
        coords, group = list(s["coords"]), [s]
        for grow_tail in (True, False):
            while True:
                tip = coords[-1] if grow_tail else coords[0]
                nxt = next((j for j in ends.get(key(tip), []) if not used[j]), None)
                if nxt is None:
                    break
                used[nxt] = True
                c = list(segs[nxt]["coords"])
                group.append(segs[nxt])
                if grow_tail:   # new piece must start at the tail
                    if key(c[-1]) == key(tip):
                        c.reverse()
                    coords.extend(c[1:])
                else:           # new piece must end at the head
                    if key(c[0]) == key(tip):
                        c.reverse()
                    coords = c[:-1] + coords
        rates = sorted(g["rate"] for g in group if g["rate"] is not None)
        chains.append({**s, "coords": coords, "rate": rates[len(rates) // 2] if rates else None})
    return chains


def build_faults(r, out):
    cfg = r["build"].get("faults", {})
    bbox = r["bbox"]
    ref_lat = (bbox[2] + bbox[3]) / 2
    path = os.path.join(CACHE, "gem_active_faults_harmonized.geojson")
    if not os.path.exists(path):
        print("downloading GEM Global Active Faults…")
        open(path, "wb").write(http(GEM_URL, timeout=180))
    feats = json.load(open(path))["features"]

    def touches(f):
        return any(bbox[0] <= c[0] <= bbox[1] and bbox[2] <= c[1] <= bbox[3] for c in f["geometry"]["coordinates"])

    traces = []
    for f in feats:
        if f["geometry"]["type"] != "LineString" or not touches(f):
            continue
        p = f["properties"]
        traces.append({
            "coords": [[c[0], c[1]] for c in f["geometry"]["coordinates"]],
            "slip_type": p.get("slip_type") or "Unknown", "rate": parse_rate(p), "name": p.get("name") or "",
        })

    # Subduction interfaces come as many two-point pieces: chain them into continuous trenches.
    sub = [t for t in traces if t["slip_type"] == "Subduction_Thrust"]
    traces = [t for t in traces if t["slip_type"] != "Subduction_Thrust"] + chain_segments(sub)

    trunk = cfg.get("trunk", [])
    min_len, min_rate = cfg.get("minLenKm", 10), cfg.get("minRate", 0)
    out_faults, counts = [], {}
    for t in traces:
        system = "other"
        for rule in trunk:
            if "nameContains" in rule and rule["nameContains"] not in t["name"]:
                continue
            if "slipType" in rule and rule["slipType"] != t["slip_type"]:
                continue
            system = rule["system"]
            break
        for run in clip_line(t["coords"], bbox):
            if length_km(run, ref_lat) < min_len and system == "other":
                continue
            if system == "other" and (t["rate"] if t["rate"] is not None else min_rate) < min_rate:
                continue
            counts[system] = counts.get(system, 0) + 1
            out_faults.append({
                "coords": [[round(c[0], 4), round(c[1], 4)] for c in run],
                "slip_type": t["slip_type"], "rate": t["rate"], "system": system, "name": t["name"],
            })
    json.dump(out_faults, open(os.path.join(out, "faults.json"), "w"), separators=(",", ":"), ensure_ascii=False)
    print("faults:", len(out_faults), counts)


# ---------------------------------------------------------------------------
# Terrain
# ---------------------------------------------------------------------------
def lon2x(lon, z):
    return (lon + 180.0) / 360.0 * (2 ** z)


def lat2y(lat, z):
    rad = math.radians(lat)
    return (1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2 * (2 ** z)


def build_terrain(r, out):
    import numpy as np
    from PIL import Image
    from scipy import ndimage as ndi

    lon_min, lon_max, lat_min, lat_max = r["bbox"]
    W, H = r["build"]["grid"]
    Z = r["build"].get("zoom", 8)
    pad = 0.15

    def fetch(tx, ty):
        path = os.path.join(CACHE, f"{Z}_{tx}_{ty}.png")
        if not os.path.exists(path):
            open(path, "wb").write(http(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png", timeout=30))
        return np.array(Image.open(path).convert("RGB"), dtype=np.float32)

    x0 = int(math.floor(lon2x(lon_min - pad, Z)))
    x1 = int(math.floor(lon2x(lon_max + pad, Z)))
    y0 = int(math.floor(lat2y(lat_max + pad, Z)))
    y1 = int(math.floor(lat2y(lat_min - pad, Z)))
    coords = [(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
    print("tiles", len(coords))
    with ThreadPoolExecutor(12) as ex:
        tiles = dict(zip(coords, ex.map(lambda c: fetch(*c), coords)))

    mw, mh = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    merc = np.zeros((mh, mw), np.float32)
    for (tx, ty), t in tiles.items():
        merc[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = \
            t[..., 0] * 256 + t[..., 1] + t[..., 2] / 256 - 32768

    # Resample mercator -> equirectangular (row 0 = south).
    lons = lon_min + (lon_max - lon_min) * np.arange(W) / (W - 1)
    lats = lat_min + (lat_max - lat_min) * np.arange(H) / (H - 1)
    px = (lon2x(lons, Z) - x0) * 256
    py = np.array([(lat2y(l, Z) - y0) * 256 for l in lats])
    gx, gy = np.meshgrid(px, py)
    elev = ndi.map_coordinates(merc, [gy, gx], order=1, mode="nearest").astype(np.float32)

    # Pixel size relative to the Türkiye build (~0.6 km): filter radii are given in those units.
    km_x = (lon_max - lon_min) / (W - 1) * 111.0 * math.cos(math.radians((lat_min + lat_max) / 2))
    km_y = (lat_max - lat_min) / (H - 1) * 111.0
    f = 0.6 / ((km_x + km_y) / 2)
    sig = lambda s, lo=0.5: max(lo, s * f)  # noqa: E731
    print(f"pixel ~{(km_x + km_y) / 2:.2f} km, filter scale {f:.2f}")

    # Single-pixel voids/spikes in the source tiles would show up as needles at this exaggeration.
    med = ndi.median_filter(elev, size=5)
    spikes = np.abs(elev - med) > 700
    elev[spikes] = med[spikes]
    print("spikes removed:", int(spikes.sum()))

    # Light smoothing tames SRTM speckle at this exaggeration (keeps coastlines crisp).
    elev = ndi.gaussian_filter(elev, sig(0.8, 0.6))

    if r["build"].get("inlandFix", r["id"] == "california"):
        # Basins below sea level that don't connect to the ocean (Salton Sea, Death Valley…) are land here.
        lab, _ = ndi.label(elev < 0, structure=np.ones((3, 3)))
        edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        inland = (elev < 0) & ~np.isin(lab, edge[edge > 0])
        elev[inland] = 0.5
        print("inland basin pixels lifted:", int(inland.sum()))
    print("elev min/max", float(elev.min()), float(elev.max()))

    # Elevation in metres, lossless in a PNG: R = high byte, G = low byte of (metres + 8192).
    enc = (elev.round().astype(np.int32) + 8192).clip(0, 65535)
    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[..., 0] = enc >> 8
    rgb[..., 1] = enc & 255
    Image.fromarray(rgb[::-1]).save(os.path.join(out, "terrain_h.png"), optimize=True)  # row 0 = north in the file
    json.dump({"w": W, "h": H, "lonMin": lon_min, "lonMax": lon_max, "latMin": lat_min, "latMax": lat_max},
              open(os.path.join(out, "terrain_meta.json"), "w"))

    # --- Albedo ---
    climate = {"wetBias": 0.0, "wetLatStart": 40.2, "wetLatGain": 0.25, "wetLatMax": 0.35, **r["build"].get("climate", {})}
    rng = np.random.default_rng(7)
    land = elev > 0
    sm = ndi.gaussian_filter(elev, sig(1.2))  # smoothed elevation for slope / cavity measures
    gy_, gx_ = np.gradient(sm)
    px_km_x = (lon_max - lon_min) / (W - 1) * 111.0 * np.cos(np.radians(lats))[:, None]
    slope = np.hypot(gx_ / (px_km_x * 1000), gy_ / (km_y * 1000))  # rise/run
    slope_deg = np.degrees(np.arctan(slope))

    # Vegetation: wetter near the sea, drier inland, nothing above the tree line.
    sea_prox = ndi.gaussian_filter((~land).astype(np.float32), sig(55, 8))
    wet = np.clip(sea_prox * 2.1, 0, 1)
    lat_grid = np.broadcast_to(lats[:, None], elev.shape)
    wet = np.clip(wet + climate["wetBias"] + np.clip((lat_grid - climate["wetLatStart"]) * climate["wetLatGain"], 0, climate["wetLatMax"]), 0, 1)
    veg = wet * np.clip(1 - (elev - 1400) / 1500, 0, 1)

    def ramp(values, stops):
        xs = np.array([s[0] for s in stops], np.float32)
        cs = np.array([s[1] for s in stops], np.float32)
        res = np.empty(values.shape + (3,), np.float32)
        for k in range(3):
            res[..., k] = np.interp(values, xs, cs[:, k])
        return res

    dry = ramp(elev, [
        (0, (200, 205, 158)), (300, (216, 208, 152)), (800, (226, 208, 156)),
        (1300, (222, 200, 152)), (1800, (205, 182, 142)), (2400, (184, 160, 132)),
        (3000, (172, 156, 140)), (3600, (214, 208, 202)), (4200, (244, 244, 246)),
        (5200, (255, 255, 255))])
    green = ramp(elev, [
        (0, (150, 182, 118)), (400, (140, 172, 112)), (1000, (150, 170, 114)),
        (1600, (172, 180, 128)), (2200, (190, 184, 140)), (4000, (214, 208, 202))])
    col = dry * (1 - veg[..., None] * 0.75) + green * (veg[..., None] * 0.75)

    rock = np.clip((slope_deg - 9) / 22, 0, 1)[..., None]
    col = col * (1 - rock * 0.55) + np.array([150, 138, 126], np.float32) * rock * 0.55
    snow = np.clip((elev - 3000) / 700, 0, 1) * np.clip(1.15 - slope_deg / 45, 0.25, 1)
    col = col * (1 - snow[..., None]) + np.array([248, 249, 251], np.float32) * snow[..., None]

    # Cavity / ridge shading baked in softly (valleys darker, ridges lighter).
    cav = np.clip((sm - ndi.gaussian_filter(sm, sig(9, 2))) / 260.0, -1, 1)
    col *= (1 + 0.10 * cav)[..., None]

    grain = ndi.gaussian_filter(rng.normal(0, 1, elev.shape).astype(np.float32), 0.8)
    col *= (1 + 0.035 * grain / grain.std())[..., None]

    # Ocean by depth, bright shoreline shelf.
    depth = np.clip(-elev, 0, None)
    sea = ramp(depth, [
        (0, (186, 226, 226)), (25, (158, 212, 222)), (120, (118, 190, 214)),
        (500, (84, 156, 196)), (1500, (56, 122, 176)), (3000, (38, 92, 150)),
        (4500, (28, 70, 126)), (8000, (20, 52, 104))])
    col = np.where(land[..., None], col, sea * (1 + 0.08 * cav)[..., None])

    shore = np.array([232, 226, 200], np.float32)
    ring = np.exp(-((elev - 1) / 6.0) ** 2)[..., None] * 0.55
    col = np.where(land[..., None], col * (1 - ring) + shore * ring, col)

    img = np.clip(col, 0, 255).astype(np.uint8)[::-1]  # image row 0 = north
    Image.fromarray(img).save(os.path.join(out, "terrain_albedo.jpg"), quality=93, subsampling=0)
    print("terrain saved", img.shape)


STEPS = {"quakes": build_quakes, "faults": build_faults, "terrain": build_terrain}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    rid = sys.argv[1]
    regions = json.load(open(os.path.join(DATA, "regions.json")))["regions"]
    if rid not in regions:
        sys.exit(f"unknown region {rid!r}; have {', '.join(regions)}")
    r = {**regions[rid], "id": rid}
    wanted = sys.argv[2:] or list(STEPS)
    if r["build"].get("prebuilt") and not sys.argv[2:]:
        sys.exit(f"{rid} is prebuilt; name the steps to rebuild explicitly")
    out = os.path.join(DATA, rid)
    os.makedirs(out, exist_ok=True)
    for step in wanted:
        print(f"== {rid}: {step}")
        STEPS[step](r, out)


if __name__ == "__main__":
    main()
