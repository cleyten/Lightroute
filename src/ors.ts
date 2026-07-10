// Round-trip route generation via OpenRouteService (free tier).
// BRouter cannot generate loops; ORS can: given one start point and a target
// length it plans a round trip. The API key is injected at build time from the
// VITE_ORS_KEY environment variable (.env.local locally, a repo secret in CI)
// so it never lives in the committed source.
//
// Raw ORS loops are often poor (dead-end detours to pad distance, "gravel"
// loops without gravel), so this module generates a batch of candidates,
// measures each one (self-overlap, roundness, surface mix, coverage of the
// signed cycle network, wind alignment) and only offers the ones that pass
// the quality gates. When nothing passes, the caller gets the failure reason
// plus the least-bad loop as an explicit fallback.
import type { FeatureCollection, Feature, LineString } from 'geojson';
import type { LngLat, RouteResult } from './routing';
import { cumulativeDistances } from './geo';
import { overlapRatio, loopRoundness, initialBearing, edgeSet, routeSimilarity } from './loops';
import { fetchNetworkGrid, networkCoverage } from './network';
import { fetchWind, windBonus, windNote, type WindInfo } from './wind';
import { surfaceFromOrsExtras, unpavedFraction, type OrsSurfaceExtra } from './surface';

const ORS_KEY: string = import.meta.env.VITE_ORS_KEY ?? '';
const ORS_BASE = 'https://api.openrouteservice.org/v2/directions';

const ORS_PROFILES: Record<string, string> = {
  race: 'cycling-road',
  gravel: 'cycling-regular',
  mtb: 'cycling-mountain',
};

/** Default hard limit on distance deviation; the UI slider overrides it. */
export const DEFAULT_MAX_DEVIATION = 0.12;
/** Number of candidate loops generated per batch. */
const CANDIDATES = 6;
/** Max options offered to the user. */
const MAX_OPTIONS = 3;
/** Reject candidates that re-ride more than this share of their distance. */
const MAX_OVERLAP = 0.1;
/** Minimum unpaved share (of known surface) per bike type. */
const MIN_UNPAVED: Record<string, number> = { gravel: 0.22, mtb: 0.3 };
/** Two candidates sharing more than this are considered the same loop. */
const MAX_SIMILARITY = 0.62;

export interface LoopOption {
  route: RouteResult;
  /** Share of distance ridden over ground already ridden (0..1). */
  overlap: number;
  roundness: number;
  /** Unpaved share of known surface, or null when surface is mostly unknown. */
  unpaved: number | null;
  /** Share of the loop on signed cycle routes, or null without network data. */
  network: number | null;
  /** e.g. "headwind out, tailwind home", when wind is relevant. */
  windNote: string | null;
  score: number;
  /** Why this loop failed the quality gates (fallback loops only). */
  rejection: string | null;
}

export interface RoundTripResult {
  /** Loops that passed all quality gates, best first. */
  options: LoopOption[];
  /** Least-bad rejected loop, offered when options is empty. */
  fallback: LoopOption | null;
  /** Dominant rejection reason, for the "nothing found" message. */
  failReason: string | null;
  wind: WindInfo | null;
}

export async function generateRoundTrips(
  start: LngLat,
  lengthMeters: number,
  bike: string,
  preferHills: boolean,
  maxDeviation: number = DEFAULT_MAX_DEVIATION,
): Promise<RoundTripResult> {
  // The loop of length L fits inside a circle of diameter L/pi around the
  // start; fetch the cycle network for that area (plus margin) in parallel
  // with the first candidate batch.
  const networkRadius = Math.min(lengthMeters / Math.PI / 2 + 3000, 20000);
  const [firstBatch, grid, wind] = await Promise.all([
    fetchCandidates(start, lengthMeters, bike),
    fetchNetworkGrid(start, networkRadius),
    fetchWind(start),
  ]);

  let evaluated = firstBatch.map((route) =>
    evaluateCandidate(route, lengthMeters, bike, preferHills, grid, wind, maxDeviation),
  );

  // ORS treats the length as a loose target and often overshoots. If too few
  // candidates pass, retry once, correcting the requested length by how far
  // the first batch was off (e.g. all loops 15% long -> ask for 15% less).
  if (evaluated.filter((c) => c.rejection === null).length < 2) {
    const median = medianDistance(firstBatch);
    const corrected = Math.round(lengthMeters * Math.min(Math.max(lengthMeters / median, 0.7), 1.3));
    try {
      const secondBatch = await fetchCandidates(start, corrected, bike);
      evaluated = evaluated.concat(
        secondBatch.map((route) =>
          evaluateCandidate(route, lengthMeters, bike, preferHills, grid, wind, maxDeviation),
        ),
      );
    } catch {
      // The first batch is still usable if the retry fails (e.g. quota).
    }
  }

  const passed = dedupe(evaluated.filter((c) => c.rejection === null)).slice(0, MAX_OPTIONS);
  const rejected = evaluated
    .filter((c) => c.rejection !== null)
    .sort((a, b) => b.score - a.score);

  return {
    options: passed,
    fallback: passed.length === 0 ? rejected[0] ?? null : null,
    failReason: passed.length === 0 ? dominantReason(rejected) : null,
    wind,
  };
}

function evaluateCandidate(
  route: RouteResult,
  targetMeters: number,
  bike: string,
  preferHills: boolean,
  grid: Awaited<ReturnType<typeof fetchNetworkGrid>>,
  wind: WindInfo | null,
  maxDeviation: number,
): LoopOption {
  const coords = route.coordinates;
  const overlap = overlapRatio(coords);
  const roundness = loopRoundness(coords, route.distanceMeters);
  const unpaved = unpavedFraction(route.surface ?? null);
  const network = grid ? networkCoverage(grid, coords) : null;
  const bearing = initialBearing(coords);
  const deviation = Math.abs(route.distanceMeters - targetMeters) / targetMeters;

  // Hard quality gates. The rejection text feeds the "nothing found" message.
  let rejection: string | null = null;
  if (deviation > maxDeviation) {
    rejection = 'distance';
  } else if (overlap > MAX_OVERLAP) {
    rejection = 'overlap';
  } else if (roundness < (preferHills ? 0.15 : 0.22)) {
    rejection = 'shape';
  } else if (MIN_UNPAVED[bike] !== undefined && unpaved !== null && unpaved < MIN_UNPAVED[bike]) {
    rejection = 'surface';
  }

  // Deviations within 40% of the tolerance carry no penalty at all.
  let score = roundness - Math.max(0, deviation - maxDeviation * 0.4) * 8 - overlap * 6;
  if (network !== null) score += network * 1.2;
  score += windBonus(wind, bearing);
  if (preferHills) {
    // Meters of climbing per km; ~10 m/km is seriously hilly for NL/BE.
    score += (route.ascendMeters / (route.distanceMeters / 1000) / 10) * 1.5;
  }
  if (unpaved !== null && MIN_UNPAVED[bike] !== undefined) score += unpaved * 0.8;
  if (unpaved !== null && bike === 'race') score -= unpaved * 1.5;

  return {
    route,
    overlap,
    roundness,
    unpaved,
    network,
    windNote: wind ? windNote(wind, bearing) : null,
    score,
    rejection,
  };
}

/** Drops near-duplicate loops, keeping the better-scoring one. */
function dedupe(options: LoopOption[]): LoopOption[] {
  const sorted = [...options].sort((a, b) => b.score - a.score);
  const kept: { option: LoopOption; edges: Set<string> }[] = [];
  for (const option of sorted) {
    const edges = edgeSet(option.route.coordinates);
    if (kept.every((k) => routeSimilarity(k.edges, edges) < MAX_SIMILARITY)) {
      kept.push({ option, edges });
    }
  }
  return kept.map((k) => k.option);
}

const REASON_TEXT: Record<string, string> = {
  overlap: 'every loop found here doubles back on itself too much',
  shape: 'only awkwardly shaped loops were found here',
  surface: 'not enough unpaved roads were found for a loop of this length',
  distance: 'no loop close enough to this distance was found',
};

function dominantReason(rejected: LoopOption[]): string {
  const counts = new Map<string, number>();
  for (const r of rejected) {
    counts.set(r.rejection!, (counts.get(r.rejection!) ?? 0) + 1);
  }
  let best = 'overlap';
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return REASON_TEXT[best] ?? REASON_TEXT.overlap;
}

export function rejectionText(option: LoopOption): string {
  switch (option.rejection) {
    case 'overlap':
      return `${Math.round(option.overlap * 100)}% of it doubles back on itself`;
    case 'shape':
      return 'it is awkwardly shaped';
    case 'surface':
      return `only ${Math.round((option.unpaved ?? 0) * 100)}% of it is unpaved`;
    case 'distance':
      return `its distance is ${(option.route.distanceMeters / 1000).toFixed(1)} km`;
    default:
      return '';
  }
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

function medianDistance(candidates: RouteResult[]): number {
  const sorted = candidates.map((c) => c.distanceMeters).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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
      extra_info: ['surface'],
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
  const extras = feature.properties?.extras as { surface?: OrsSurfaceExtra } | undefined;

  return {
    geojson: data,
    coordinates,
    distanceMeters: summary.distance ?? 0,
    ascendMeters: estimateAscent(coordinates),
    messages: [], // ORS provides no BRouter-style way tags; surface comes from extras.
    surface: surfaceFromOrsExtras(extras?.surface, cumulativeDistances(coordinates)),
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
