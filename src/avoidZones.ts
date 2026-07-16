// Circular "avoid this area" zones for manual routes, drawn as a polygon so
// the radius stays accurate in meters across zoom levels (MapLibre's
// circle-radius paint property is in pixels, not meters). Uses the same
// local equirectangular projection as loops.ts's projectToMeters, duplicated
// here as a 2-line formula rather than importing across modules, to keep
// this feature decoupled from round-trip generation.
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { LngLat } from './routing';

const EARTH_RADIUS_M = 6371000;

export interface AvoidZone {
  lngLat: LngLat;
  radiusM: number;
}

/** Builds a circular polygon of `radiusM` meters around `lngLat`. */
export function zoneToPolygon(lngLat: LngLat, radiusM: number, steps = 48): Feature<Polygon> {
  const [lng0, lat0] = lngLat;
  const lat0Rad = (lat0 * Math.PI) / 180;
  const kx = EARTH_RADIUS_M * Math.cos(lat0Rad) * (Math.PI / 180);
  const ky = EARTH_RADIUS_M * (Math.PI / 180);
  const cx = lng0 * kx;
  const cy = lat0 * ky;

  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    const px = cx + radiusM * Math.cos(angle);
    const py = cy + radiusM * Math.sin(angle);
    ring.push([px / kx, py / ky]);
  }

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/** Rebuilds the avoid-zones GeoJSON source data from the current zone list. */
export function buildAvoidZonesGeoJson(zones: AvoidZone[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: zones.map((zone, index) => ({
      ...zoneToPolygon(zone.lngLat, zone.radiusM),
      properties: { zoneIndex: index },
    })),
  };
}
