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

/** The public BRouter server is usually fast, but it does occasionally hang. */
const TIMEOUT_MS = 20000;

/**
 * Thrown when the caller aborted the request (a newer route superseded it).
 * Callers should ignore this rather than showing it as a failure.
 */
export class RouteCancelledError extends Error {
  constructor() {
    super('Route request cancelled.');
    this.name = 'RouteCancelledError';
  }
}

export async function fetchRoute(
  waypoints: LngLat[],
  profile: string = 'fastbike-lowtraffic',
  signal?: AbortSignal,
): Promise<RouteResult> {
  const lonlats = waypoints.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;

  // Two reasons to give up: the caller superseded this request, or the server
  // never answered. Both abort the same fetch, so they are told apart after the
  // fact by asking whether the caller's own signal is the one that fired.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onCallerAbort = (): void => timeout.abort();
  signal?.addEventListener('abort', onCallerAbort);

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { signal: timeout.signal });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new RouteCancelledError();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The routing server did not respond in time. Try again.');
    }
    throw new Error('Could not reach the routing server. Check your connection.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }

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
