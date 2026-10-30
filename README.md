# Seismic Atlas

Interactive 3D maps of earthquakes with a playable timeline, a surface view and a depth view. Switch between regions with the pills at the top (or keys `1`–`3`, or `?region=turkey|california|japan`):

- **Türkiye**: North and East Anatolian Faults, M ≥ 3.5, 1904–2026
- **California**: San Andreas system and Cascadia, M ≥ 3.5, 1900–2026
- **Japan**: Japan, Kuril, Nankai and Izu–Bonin trenches, M ≥ 4.5, 1900–2026 (events deeper than 200 km not shown)

Built with [three.js](https://threejs.org). Open `index.html` through any static web server (it loads data files, so `file://` will not work), e.g. `python3 -m http.server`.

Keys: `Space` play/pause · `D` depth view · `R` reset camera · `L` labels · `1`–`3` region.

## Adding a region

Add an entry to `data/regions.json` (bounding box, labels, cities, notable quakes, build settings), then build its data into `data/<id>/` with `tools/build_region.py <id>` (needs numpy, scipy, pillow; it pulls USGS, GEM and AWS terrain tiles). The tools live in the source project, not this repo.

## Data and credits

- **Earthquakes**: USGS ANSS Comprehensive Catalog (ComCat), public domain.
- **Faults**: [GEM Global Active Faults Database](https://github.com/GEMScienceTools/gem-global-active-faults), CC BY-SA 4.0. Each `data/<region>/faults.json` is a filtered, clipped derivative and is shared under the same licence.
- **Relief and bathymetry**: Mapzen / AWS Terrain Tiles, which combine SRTM, GEBCO and other sources (see https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Resampled into `data/<region>/terrain_h.png` and a baked colour map `data/<region>/terrain_albedo.jpg`.
- Vertical scales are exaggerated: relief about 18×, hypocentre depth about 2.7×. The depth ruler shows true kilometres.
