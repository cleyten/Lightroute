// Signed cycle-route network from OpenStreetMap via the Overpass API.
// Node networks (rcn, common in NL/BE) and local cycle routes are a good
// public proxy for "loops people actually ride": they are curated,
// signposted routes. Used to score round-trip candidates; a public heatmap
// like Strava's is not usable (login-gated, license forbids reuse).

import { projectToMeters, resample } from './loops';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Cell size in meters for the presence grid; with the 8 neighbors a route
 *  point counts as "on the network" within roughly 2 cells. */
const CELL = 30;
/** Cap on returned ways so one request never exceeds a few MB. */
const MAX_WAYS = 6000;

export interface NetworkGrid {
  cells: Set<string>;
  /** Projection origin so route points land in the same grid. */
  origin: [number, number];
}

interface OverpassWay {
  type: string;
  geometry?: { lat: number; lon: number }[];
}

// One area is fetched per session at most; keyed by rounded center + radius.
const cache = new Map<string, NetworkGrid | null>();

/**
 * Fetches cycle-network way geometry around `center` (lng, lat) and builds a
 * lookup grid. Returns null when Overpass is unreachable or slow; the caller
 * then simply scores without the network signal.
 */
export async function fetchNetworkGrid(
  center: [number, number],
  radiusM: number,
): Promise<NetworkGrid | null> {
  const key = `${center[0].toFixed(2)},${center[1].toFixed(2)},${Math.round(radiusM / 5000)}`;
  if (cache.has(key)) return cache.get(key)!;

  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((center[1] * Math.PI) / 180));
  const bbox = [center[1] - dLat, center[0] - dLng, center[1] + dLat, center[0] + dLng]
    .map((v) => v.toFixed(4))
    .join(',');
  const query =
    `[out:json][timeout:15];` +
    `relation["route"="bicycle"]["network"~"^(rcn|lcn)$"](${bbox});` +
    `way(r)(${bbox});out skel geom ${MAX_WAYS};`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    const data = (await response.json()) as { elements: OverpassWay[] };

    const cells = new Set<string>();
    const origin: [number, number] = center;
    for (const way of data.elements) {
      if (!way.geometry || way.geometry.length < 2) continue;
      const coords = way.geometry.map((p) => [p.lon, p.lat] as [number, number]);
      // Anchor the projection at the shared origin so all ways and later the
      // route itself use identical grid coordinates.
      const points = resample(projectToMeters([origin, ...coords]).slice(1), CELL * 0.8);
      for (const [x, y] of points) {
        cells.add(`${Math.round(x / CELL)},${Math.round(y / CELL)}`);
      }
    }
    const grid = cells.size > 0 ? { cells, origin } : null;
    cache.set(key, grid);
    return grid;
  } catch {
    cache.set(key, null);
    return null;
  }
}

/** Fraction (0..1) of the route that runs on or right next to the network. */
export function networkCoverage(
  grid: NetworkGrid,
  coords: [number, number, number][],
): number {
  const points = resample(projectToMeters([grid.origin, ...coords]).slice(1), CELL);
  if (points.length === 0) return 0;
  let hits = 0;
  for (const [x, y] of points) {
    const cx = Math.round(x / CELL);
    const cy = Math.round(y / CELL);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        if (grid.cells.has(`${cx + dx},${cy + dy}`)) hit = true;
      }
    }
    if (hit) hits++;
  }
  return hits / points.length;
}
