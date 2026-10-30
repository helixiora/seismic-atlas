# Anatolian Seismic Atlas

An interactive 3D map of M ≥ 3.5 earthquakes along the North and East Anatolian Faults, 1904–2026, with a playable timeline, a surface view and a depth view.

Built with [three.js](https://threejs.org). Open `index.html` through any static web server (it loads data files, so `file://` will not work), e.g. `python3 -m http.server`.

Keys: `Space` play/pause · `D` depth view · `R` reset camera · `L` labels.

## Data and credits

- **Earthquakes**: USGS ANSS Comprehensive Catalog (ComCat), public domain.
- **Faults**: [GEM Global Active Faults Database](https://github.com/GEMScienceTools/gem-global-active-faults), CC BY-SA 4.0. `data/faults.json` is a filtered, tagged derivative and is shared under the same licence.
- **Relief and bathymetry**: Mapzen / AWS Terrain Tiles, which combine SRTM, GEBCO and other sources (see https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Resampled into `data/terrain_h.png` and a baked colour map `data/terrain_albedo.jpg`.
- Vertical scales are exaggerated: relief about 18×, hypocentre depth about 2.7×. The depth ruler shows true kilometres.
