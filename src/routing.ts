// Route calculation via the public BRouter server (https://brouter.de).
// BRouter is a cycling-focused, OpenStreetMap-based routing engine. It returns
// the route as GeoJSON with per-point elevation as the third coordinate.

import type { FeatureCollection } from 'geojson';
import type { SurfaceTotals } from './surface';

export type LngLat = [number, number];

export interface RouteResult {
  geojson: FeatureCollection;
  /** Route coordinates as [longitude, latitude, elevation in meters]. */
  coordinates: [number, number, number][];
  distanceMeters: number;
  ascendMeters: number;
  /** BRouter per-segment data rows (header row first); used for the surface breakdown. */
  messages: string[][];
  /** Pre-computed surface totals (ORS routes); BRouter routes derive them from messages. */
  surface?: SurfaceTotals | null;
}

const BROUTER_URL = 'https://brouter.de/brouter';

export async function fetchRoute(
  waypoints: LngLat[],
  profile: string = 'fastbike-lowtraffic',
  avoidZones: { lngLat: LngLat; radiusM: number }[] = [],
): Promise<RouteResult> {
  const lonlats = waypoints.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join('|');
  let url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  if (avoidZones.length > 0) {
    const nogos = avoidZones
      .map(({ lngLat: [lng, lat], radiusM }) => `${lng.toFixed(6)},${lat.toFixed(6)},${radiusM.toFixed(0)}`)
      .join('|');
    url += `&nogos=${nogos}`;
  }

  const response = await fetch(url);
  const text = await response.text();

  // BRouter sometimes reports errors as plain text with HTTP 200,
  // so validate the body instead of trusting the status code alone.
  let data: FeatureCollection;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(humanizeBrouterError(text));
  }
  if (!response.ok) {
    throw new Error(humanizeBrouterError(text));
  }

  const feature = data.features?.[0];
  if (!feature || feature.geometry.type !== 'LineString') {
    throw new Error('The routing server returned no route.');
  }

  const props = feature.properties ?? {};
  return {
    geojson: data,
    coordinates: feature.geometry.coordinates as [number, number, number][],
    distanceMeters: Number(props['track-length'] ?? 0),
    ascendMeters: Number(props['filtered ascend'] ?? 0),
    messages: (props['messages'] as string[][]) ?? [],
  };
}

function humanizeBrouterError(serverText: string): string {
  const detail = serverText.trim().slice(0, 200);
  if (/no track found|operation killed/i.test(detail)) {
    return 'No route found between these points. Choose points closer to a road.';
  }
  return `Routing failed: ${detail || 'unknown routing server error'}`;
}
