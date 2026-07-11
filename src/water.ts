// Drinking-water refill points along the route, found via the Overpass API.
// Mirrors cafes.ts: the route is resampled to a coarse polyline for the
// Overpass "around" filter, and each hit is positioned along the route
// (km mark + how far off-route it lies). Covers the common potable-water
// tags cyclists rely on: drinking fountains, water points and water taps.

import { projectToMeters, resample } from './loops';
import { cumulativeDistances } from './geo';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** How far off the route a refill may lie (meters). */
const SEARCH_RADIUS = 350;
/** Cap on results. */
const MAX_WATER = 80;

export interface WaterPoint {
  name: string;
  lngLat: [number, number];
  /** Position along the route, in km from the start. */
  atKm: number;
  /** Straight-line distance from the route, in meters. */
  offRouteM: number;
}

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function fetchWater(
  coordinates: [number, number, number][],
): Promise<WaterPoint[]> {
  const polyline = coarsePolyline(coordinates, 500);
  const around = `around:${SEARCH_RADIUS},${polyline}`;
  const query =
    `[out:json][timeout:20];` +
    `(` +
    `nwr["amenity"="drinking_water"](${around});` +
    `nwr["amenity"="water_point"](${around});` +
    `nwr["man_made"="water_tap"]["drinking_water"!="no"](${around});` +
    `);` +
    `out center ${MAX_WATER + 40};`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Water search failed (Overpass ${response.status}).`);
    const data = (await response.json()) as { elements: OverpassElement[] };
    return locateAlongRoute(data.elements, coordinates).slice(0, MAX_WATER);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Water search timed out; try again in a moment.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A readable label for a water point that usually has no name. */
function waterLabel(tags: Record<string, string> | undefined): string {
  if (tags?.name) return tags.name;
  if (tags?.amenity === 'water_point') return 'Water point';
  if (tags?.man_made === 'water_tap') return 'Water tap';
  return 'Drinking water';
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

/** Computes each refill's km mark and off-route distance, sorted by km. */
function locateAlongRoute(
  elements: OverpassElement[],
  coordinates: [number, number, number][],
): WaterPoint[] {
  const projected = projectToMeters(coordinates);
  const kmAlong = cumulativeDistances(coordinates);
  const lat0 = coordinates[0][1];
  const kx = 6371000 * Math.cos((lat0 * Math.PI) / 180) * (Math.PI / 180);
  const ky = 6371000 * (Math.PI / 180);

  const points: WaterPoint[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const dedupeKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
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
    points.push({
      name: waterLabel(el.tags),
      lngLat: [lon, lat],
      atKm: kmAlong[bestIndex] / 1000,
      offRouteM: Math.sqrt(bestSq),
    });
  }
  return points.sort((a, b) => a.atKm - b.atKm);
}
