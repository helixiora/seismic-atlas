# Seismic Atlas

Created by [Helixiora](https://helixiora.com). Live: https://helixiora.github.io/seismic-atlas/

Interactive 3D maps of earthquakes with a playable timeline, a surface view and a depth view. Switch between regions with the pills at the top (or keys `1`–`3`, or `?region=turkey|california|japan`):

- **Türkiye**: North and East Anatolian Faults, M ≥ 3.5, 1904–2026
- **California**: San Andreas system and Cascadia, M ≥ 3.5, 1900–2026
- **Japan**: Japan, Kuril, Nankai and Izu–Bonin trenches, M ≥ 4.5, 1900–2026 (events deeper than 200 km not shown)

Built with [three.js](https://threejs.org). Open `index.html` through any static web server (it loads data files, so `file://` will not work), e.g. `python3 -m http.server`.

Keys: `Space` play/pause · `D` depth view · `R` reset camera · `L` labels · `1`–`3` region.

## Adding a region

Add an entry to `data/regions.json` (bounding box, labels, cities, notable quakes, build settings), then build its data into `data/<id>/`:

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/build_region.py <id>            # quakes + faults + terrain
.venv/bin/python tools/build_region.py <id> faults     # or just one step
```

It pulls earthquakes from the USGS FDSN API, faults from the GEM database and elevation from AWS Terrain Tiles. Set `TILE_CACHE` to keep the downloads between runs.

## Tools

- `tools/build_region.py`: builds a region's data (above).
- `tools/serve.py`: local no-cache static server, `python3 tools/serve.py 8430`.
- `tools/build_terrain.py`, `tools/tag_faults.py`: the original Türkiye-only terrain builder and NAF/EAF fault tagger, kept for reference.
- `tools/make_artifact.py`: turns `index.html` + CSS into a single-page form for pasting into a claude.ai Artifact.

## Licence

The code (everything except the files under `data/`) is released under the [MIT License](LICENSE), copyright Helixiora. The data files keep the licences of their sources, listed below. three.js is MIT-licensed and loaded from a CDN.

## Data and credits

- **Earthquakes**: USGS ANSS Comprehensive Catalog (ComCat), public domain.
- **Faults**: [GEM Global Active Faults Database](https://github.com/GEMScienceTools/gem-global-active-faults), CC BY-SA 4.0. Each `data/<region>/faults.json` is a filtered, clipped derivative and is shared under the same CC BY-SA 4.0 licence, not MIT.
- **Relief and bathymetry**: Mapzen / AWS Terrain Tiles, which combine SRTM, GEBCO and other sources (see https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Resampled into `data/<region>/terrain_h.png` and a baked colour map `data/<region>/terrain_albedo.jpg`.
- Vertical scales are exaggerated: relief about 18×, hypocentre depth about 2.7×. The depth ruler shows true kilometres.
