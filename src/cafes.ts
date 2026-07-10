// Cafés along the route, found via the Overpass API.
// The route is resampled to a coarse polyline for the Overpass "around"
// filter; each hit is then positioned along the route (km mark + how far
// off-route it lies) so the user can plan a coffee stop around a given km.

import { projectToMeters, resample } from './loops';
import { cumulativeDistances } from './geo';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** How far off the route a café may lie (meters). */
const SEARCH_RADIUS = 300;
/** Cap on results; a city-center route can match hundreds. */
const MAX_CAFES = 80;

export interface Cafe {
  name: string;
  lngLat: [number, number];
  /** Position along the route, in km from the start. */
  atKm: number;
  /** Straight-line distance from the route, in meters. */
  offRouteM: number;
  openingHours: string | null;
}

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function fetchCafes(
  coordinates: [number, number, number][],
): Promise<Cafe[]> {
  // ~500 m spacing keeps the query body small; SEARCH_RADIUS covers the gaps.
  const polyline = coarsePolyline(coordinates, 500);
  const query =
    `[out:json][timeout:20];` +
    `nwr["amenity"="cafe"](around:${SEARCH_RADIUS},${polyline});` +
    `out center ${MAX_CAFES + 40};`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Café search failed (Overpass ${response.status}).`);
    const data = (await response.json()) as { elements: OverpassElement[] };
    return locateAlongRoute(data.elements, coordinates).slice(0, MAX_CAFES);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Café search timed out; try again in a moment.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** "lat,lon,lat,lon,..." string of the resampled route for Overpass around:. */
function coarsePolyline(coordinates: [number, number, number][], spacingM: number): string {
  const projected = projectToMeters(coordinates);
  const lat0 = coordinates[0][1];
  const kx = 6371000 * Math.cos((lat0 * Math.PI) / 180) * (Math.PI / 180);
  const ky = 6371000 * (Math.PI / 180);
  return resample(projected, spacingM)
    .map(([x, y]) => `${(y / ky).toFixed(5)},${(x / kx).toFixed(5)}`)
    .join(',');
}

/** Computes each café's km mark and off-route distance, sorted by km. */
function locateAlongRoute(
  elements: OverpassElement[],
  coordinates: [number, number, number][],
): Cafe[] {
  const projected = projectToMeters(coordinates);
  const kmAlong = cumulativeDistances(coordinates);
  const lat0 = coordinates[0][1];
  const kx = 6371000 * Math.cos((lat0 * Math.PI) / 180) * (Math.PI / 180);
  const ky = 6371000 * (Math.PI / 180);

  const cafes: Cafe[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const name = el.tags?.name ?? 'Unnamed café';
    // Ways and their nodes can both match; dedupe by name + rough position.
    const dedupeKey = `${name}|${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const px = lon * kx;
    const py = lat * ky;
    let bestIndex = 0;
    let bestSq = Infinity;
    for (let i = 0; i < projected.length; i++) {
      const dx = projected[i][0] - px;
      const dy = projected[i][1] - py;
      const sq = dx * dx + dy * dy;
      if (sq < bestSq) {
        bestSq = sq;
        bestIndex = i;
      }
    }
    cafes.push({
      name,
      lngLat: [lon, lat],
      atKm: kmAlong[bestIndex] / 1000,
      offRouteM: Math.sqrt(bestSq),
      openingHours: el.tags?.opening_hours ?? null,
    });
  }
  return cafes.sort((a, b) => a.atKm - b.atKm);
}
