// Round-trip route generation via OpenRouteService (free tier).
// BRouter cannot generate loops; ORS can: given one start point and a target
// length it plans a round trip. The API key is injected at build time from the
// VITE_ORS_KEY environment variable (.env.local locally, a repo secret in CI)
// so it never lives in the committed source.
import type { FeatureCollection, Feature, LineString } from 'geojson';
import type { LngLat, RouteResult } from './routing';

const ORS_KEY: string = import.meta.env.VITE_ORS_KEY ?? '';
const ORS_BASE = 'https://api.openrouteservice.org/v2/directions';

const ORS_PROFILES: Record<string, string> = {
  race: 'cycling-road',
  gravel: 'cycling-regular',
  mtb: 'cycling-mountain',
};

/** Distance deviation from the target that carries no penalty. */
const DISTANCE_MARGIN = 0.05;
/** Number of candidate loops generated per request; the best one is returned. */
const CANDIDATES = 4;

/**
 * Generates several candidate loops and returns the best one.
 * Without `preferHills` the roundest loop wins (ORS otherwise tends to add
 * awkward filler loops just to hit the exact distance); with `preferHills`
 * the loop with the most climbing per kilometer wins. Distance may deviate
 * up to DISTANCE_MARGIN from the target before it is penalized.
 */
export async function fetchRoundTrip(
  start: LngLat,
  lengthMeters: number,
  bike: string,
  preferHills: boolean,
): Promise<RouteResult> {
  let candidates = await fetchCandidates(start, lengthMeters, bike);

  // ORS treats the length as a loose target and often overshoots. If every
  // candidate misses the margin, retry once with a corrected request length
  // (e.g. all loops came out 15% long -> ask for 15% less).
  let best = pickBest(candidates, lengthMeters, preferHills);
  const deviation = Math.abs(best.distanceMeters - lengthMeters) / lengthMeters;
  if (deviation > DISTANCE_MARGIN) {
    const median = medianDistance(candidates);
    const corrected = Math.round(lengthMeters * (lengthMeters / median));
    try {
      const secondBatch = await fetchCandidates(start, corrected, bike);
      candidates = candidates.concat(secondBatch);
      best = pickBest(candidates, lengthMeters, preferHills);
    } catch {
      // The first batch is still usable if the retry fails (e.g. quota).
    }
  }
  return best;
}

async function fetchCandidates(
  start: LngLat,
  lengthMeters: number,
  bike: string,
): Promise<RouteResult[]> {
  const attempts = await Promise.allSettled(
    Array.from({ length: CANDIDATES }, () => fetchOneRoundTrip(start, lengthMeters, bike)),
  );
  const candidates = attempts
    .filter((a): a is PromiseFulfilledResult<RouteResult> => a.status === 'fulfilled')
    .map((a) => a.value);

  if (candidates.length === 0) {
    throw (attempts[0] as PromiseRejectedResult).reason;
  }
  return candidates;
}

function pickBest(
  candidates: RouteResult[],
  targetMeters: number,
  preferHills: boolean,
): RouteResult {
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, targetMeters, preferHills);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function medianDistance(candidates: RouteResult[]): number {
  const sorted = candidates.map((c) => c.distanceMeters).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function scoreCandidate(
  route: RouteResult,
  targetMeters: number,
  preferHills: boolean,
): number {
  const deviation = Math.abs(route.distanceMeters - targetMeters) / targetMeters;
  // Heavy penalty: a loop within the margin should nearly always win.
  const deviationPenalty = Math.max(0, deviation - DISTANCE_MARGIN) * 10;
  const roundness = loopRoundness(route);

  if (preferHills) {
    // Meters of climbing per km; ~10 m/km is seriously hilly for NL/BE.
    const climbPerKm = route.ascendMeters / (route.distanceMeters / 1000);
    return climbPerKm / 10 + roundness * 0.3 - deviationPenalty;
  }
  return roundness - deviationPenalty;
}

/**
 * Isoperimetric quotient (4·pi·area / perimeter²): 1 for a perfect circle,
 * near 0 for out-and-back shapes or loops with filler curls.
 */
function loopRoundness(route: RouteResult): number {
  const coords = route.coordinates;
  if (coords.length < 3 || route.distanceMeters === 0) return 0;

  // Equirectangular projection is accurate enough at loop scale.
  const R = 6371000;
  const lat0 = (coords[0][1] * Math.PI) / 180;
  const project = ([lng, lat]: [number, number, number]): [number, number] => [
    ((lng * Math.PI) / 180) * R * Math.cos(lat0),
    ((lat * Math.PI) / 180) * R,
  ];

  let doubleArea = 0;
  let [prevX, prevY] = project(coords[0]);
  for (let i = 1; i < coords.length; i++) {
    const [x, y] = project(coords[i]);
    doubleArea += prevX * y - x * prevY;
    prevX = x;
    prevY = y;
  }
  const area = Math.abs(doubleArea) / 2;
  return (4 * Math.PI * area) / route.distanceMeters ** 2;
}

async function fetchOneRoundTrip(
  start: LngLat,
  lengthMeters: number,
  bike: string,
): Promise<RouteResult> {
  if (!ORS_KEY) {
    throw new Error('No OpenRouteService key configured (VITE_ORS_KEY).');
  }

  const profile = ORS_PROFILES[bike] ?? 'cycling-road';
  const response = await fetch(`${ORS_BASE}/${profile}/geojson`, {
    method: 'POST',
    headers: {
      Authorization: ORS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      coordinates: [start],
      elevation: true,
      instructions: false,
      options: {
        round_trip: {
          length: lengthMeters,
          points: 5,
          // A random seed gives a different loop on every attempt.
          seed: Math.floor(Math.random() * 1_000_000),
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(humanizeOrsError(response.status, body));
  }

  const data = (await response.json()) as FeatureCollection;
  const feature = data.features?.[0] as Feature<LineString> | undefined;
  if (!feature) {
    throw new Error('The routing server returned no round trip.');
  }

  const coordinates = feature.geometry.coordinates as [number, number, number][];
  const summary = (feature.properties?.summary ?? {}) as { distance?: number };

  return {
    geojson: data,
    coordinates,
    distanceMeters: summary.distance ?? 0,
    ascendMeters: estimateAscent(coordinates),
    messages: [], // ORS provides no BRouter-style way tags; surface bar stays hidden.
  };
}

/** Sum of positive elevation differences, ignoring sub-2m jitter. */
function estimateAscent(coordinates: [number, number, number][]): number {
  let ascent = 0;
  let reference = coordinates[0]?.[2] ?? 0;
  for (const [, , elevation] of coordinates) {
    const delta = (elevation ?? reference) - reference;
    if (delta >= 2) {
      ascent += delta;
      reference = elevation;
    } else if (delta <= -2) {
      reference = elevation;
    }
  }
  return ascent;
}

function humanizeOrsError(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'The OpenRouteService key was rejected. Check the key or its domain restriction.';
  }
  if (status === 429) {
    return 'The OpenRouteService daily quota has been reached. Try again tomorrow.';
  }
  if (/2004/.test(body)) {
    return 'The requested distance is too long for a round trip (100 km maximum).';
  }
  return `Round trip generation failed (error ${status}).`;
}
