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
import {
  extrasToSegmentCodes,
  surfaceFromSegmentCodes,
  unpavedFraction,
  type OrsSurfaceExtra,
} from './surface';
import { cleanLoopGeometry, healWiggles, findWiggles } from './cleanup';

// When VITE_USE_PROXY is set (Cloudflare build), route requests through the
// same-origin Worker proxy, which injects the key server-side — so the key is
// never in the bundle. Otherwise call OpenRouteService directly with the
// build-time key (GitHub Pages / local dev).
const ORS_KEY: string = import.meta.env.VITE_ORS_KEY ?? '';
// Route through the same-origin Worker proxy (which injects the key
// server-side) whenever no direct key is baked into the bundle — that is the
// Cloudflare build. GitHub Pages and local dev bake VITE_ORS_KEY and call ORS
// directly. VITE_USE_PROXY=1 forces the proxy explicitly (e.g. `preview:cf`).
// The PROD guard keeps `npm run dev` (no key) throwing a clear error instead of
// proxying to an endpoint that only exists on the deployed Worker.
const USE_PROXY = import.meta.env.VITE_USE_PROXY === '1' || (import.meta.env.PROD && !ORS_KEY);
const ORS_BASE = USE_PROXY ? '/api/ors' : 'https://api.openrouteservice.org/v2/directions';

const ORS_PROFILES: Record<string, string> = {
  race: 'cycling-road',
  gravel: 'cycling-regular',
  mtb: 'cycling-mountain',
};

/** BRouter profiles used to re-route (heal) detour wiggles per bike type. */
const HEAL_PROFILES: Record<string, string> = {
  race: 'fastbike',
  gravel: 'gravel',
  mtb: 'mtb',
};

/** Number of candidate loops generated per batch. */
const CANDIDATES = 8;
/** Max options offered to the user. */
const MAX_OPTIONS = 3;
/** Reject candidates that re-ride more than this share of their distance. */
const MAX_OVERLAP = 0.1;
/** Minimum unpaved share (of known surface) per bike type. */
const MIN_UNPAVED: Record<string, number> = { gravel: 0.22, mtb: 0.3 };
/** Two candidates sharing more than this are considered the same loop. */
const MAX_SIMILARITY = 0.62;

export type HillPreference = 'avoid' | 'mix' | 'prefer';

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

/**
 * Reports how far along generation is. Generation takes tens of seconds and
 * fans out over a hundred requests, so a single "please wait" is not enough to
 * tell a slow run from a stuck one.
 */
export type ProgressReporter = (done: number, total: number, phase: string) => void;

export async function generateRoundTrips(
  start: LngLat,
  minMeters: number,
  maxMeters: number,
  bike: string,
  hills: HillPreference,
  onProgress: ProgressReporter = () => {},
): Promise<RoundTripResult> {
  // ORS wants a single target length; aim for the middle of the range.
  const targetMeters = (minMeters + maxMeters) / 2;
  // The loop of length L fits inside a circle of diameter L/pi around the
  // start; fetch the cycle network for that area (plus margin) in parallel
  // with the first candidate batch.
  const networkRadius = Math.min(maxMeters / Math.PI / 2 + 3000, 20000);
  onProgress(0, CANDIDATES, 'Planning loops');
  const [firstBatch, grid, wind] = await Promise.all([
    fetchCandidates(start, targetMeters, bike, onProgress),
    fetchNetworkGrid(start, networkRadius),
    fetchWind(start),
  ]);

  onProgress(CANDIDATES, CANDIDATES, 'Checking quality');
  let evaluated = firstBatch.map((route) =>
    evaluateCandidate(route, minMeters, maxMeters, bike, hills, grid, wind),
  );

  // ORS treats the length as a loose target and often overshoots. If too few
  // candidates pass, retry once, correcting the requested length by how far
  // the first batch was off (e.g. all loops 15% long -> ask for 15% less).
  if (evaluated.filter((c) => c.rejection === null).length < 2) {
    const median = medianDistance(firstBatch);
    const corrected = Math.round(
      targetMeters * Math.min(Math.max(targetMeters / median, 0.7), 1.3),
    );
    try {
      onProgress(0, CANDIDATES, 'Trying a second batch');
      const secondBatch = await fetchCandidates(start, corrected, bike, onProgress);
      evaluated = evaluated.concat(
        secondBatch.map((route) =>
          evaluateCandidate(route, minMeters, maxMeters, bike, hills, grid, wind),
        ),
      );
    } catch {
      // The first batch is still usable if the retry fails (e.g. quota).
    }
  }

  // ORS round trips can't be biased toward elevation, so all candidates are
  // generated the same way. We can only pick the flattest (avoid) or hilliest
  // (prefer) of the ones that pass the quality gates; in uniformly hilly areas
  // the achievable spread is small. "mix" just ranks by overall quality.
  const passing = evaluated
    .filter((c) => c.rejection === null)
    .sort((a, b) => hillsSortValue(b, hills) - hillsSortValue(a, hills));
  const passed = dedupe(passing).slice(0, MAX_OPTIONS);
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
  minMeters: number,
  maxMeters: number,
  bike: string,
  hills: HillPreference,
  grid: Awaited<ReturnType<typeof fetchNetworkGrid>>,
  wind: WindInfo | null,
): LoopOption {
  const coords = route.coordinates;
  const overlap = overlapRatio(coords);
  const roundness = loopRoundness(coords, route.distanceMeters);
  const unpaved = unpavedFraction(route.surface ?? null);
  const network = grid ? networkCoverage(grid, coords) : null;
  const bearing = initialBearing(coords);

  // Hard quality gates. The rejection text feeds the "nothing found" message.
  let rejection: string | null = null;
  if (route.distanceMeters < minMeters || route.distanceMeters > maxMeters) {
    rejection = 'distance';
  } else if (overlap > MAX_OVERLAP) {
    rejection = 'overlap';
  } else if (roundness < (hills === 'prefer' ? 0.15 : 0.22)) {
    rejection = 'shape';
  } else if (MIN_UNPAVED[bike] !== undefined && unpaved !== null && unpaved < MIN_UNPAVED[bike]) {
    rejection = 'surface';
  }

  // Any distance inside the requested range is equally fine; outside it,
  // penalize by how far out it lies (matters for ranking fallback loops).
  const overshoot =
    Math.max(0, minMeters - route.distanceMeters, route.distanceMeters - maxMeters) /
    ((minMeters + maxMeters) / 2);
  let score = roundness - overshoot * 8 - overlap * 6;
  if (network !== null) score += network * 1.2;
  score += windBonus(wind, bearing);
  if (unpaved !== null && MIN_UNPAVED[bike] !== undefined) score += unpaved * 0.8;
  if (unpaved !== null && bike === 'race') score -= unpaved * 1.5;

  // Wiggles that survived healing had no shorter through-road, so they are
  // rideable; still, prefer candidates that flow without such knots.
  score -= findWiggles(coords).length * 0.35;

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

/** Meters of climbing per km; used to order loops by the hills preference. */
function ascentPerKm(option: LoopOption): number {
  return option.route.ascendMeters / (option.route.distanceMeters / 1000);
}

/** Sort value (higher = offered first) for the chosen hills preference. */
function hillsSortValue(option: LoopOption, hills: HillPreference): number {
  if (hills === 'prefer') return ascentPerKm(option);
  if (hills === 'avoid') return -ascentPerKm(option);
  return option.score;
}

/** Drops near-duplicate loops, keeping the first (caller pre-sorts best-first). */
function dedupe(options: LoopOption[]): LoopOption[] {
  const kept: { option: LoopOption; edges: Set<string> }[] = [];
  for (const option of options) {
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
  distance: 'no loop within the distance range was found',
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

// rejectionText lives in loopText.ts so the UI can format a rejection without
// importing this module (and dragging the whole pipeline into the main bundle).

async function fetchCandidates(
  start: LngLat,
  lengthMeters: number,
  bike: string,
  onProgress: ProgressReporter = () => {},
): Promise<RouteResult[]> {
  let settled = 0;
  const attempts = await Promise.allSettled(
    Array.from({ length: CANDIDATES }, () =>
      fetchOneRoundTrip(start, lengthMeters, bike).finally(() => {
        onProgress(++settled, CANDIDATES, 'Planning loops');
      }),
    ),
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
  if (!USE_PROXY && !ORS_KEY) {
    throw new Error('No OpenRouteService key configured (VITE_ORS_KEY).');
  }

  const profile = ORS_PROFILES[bike] ?? 'cycling-road';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // The proxy adds the Authorization header itself; only send it when calling
  // OpenRouteService directly.
  if (!USE_PROXY) headers.Authorization = ORS_KEY;
  const response = await fetch(`${ORS_BASE}/${profile}/geojson`, {
    method: 'POST',
    headers,
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

  const rawCoordinates = feature.geometry.coordinates as [number, number, number][];
  const extras = feature.properties?.extras as { surface?: OrsSurfaceExtra } | undefined;

  // Splice dead-end spurs and small self-intersection curls out of the raw
  // geometry, then heal residential-block detours by re-routing them through
  // BRouter; distance, ascent and surface are recomputed from the result.
  const cleaned = cleanLoopGeometry(
    rawCoordinates,
    extrasToSegmentCodes(extras?.surface, rawCoordinates.length),
  );
  const healed = await healWiggles(
    cleaned.coords,
    cleaned.segCodes,
    HEAL_PROFILES[bike] ?? 'fastbike',
  );
  // Healing can join roads in ways that create a fresh micro-artifact.
  const final = cleanLoopGeometry(healed.coords, healed.segCodes);
  const coordinates = final.coords;
  const cumulative = cumulativeDistances(coordinates);

  return {
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates },
        },
      ],
    },
    coordinates,
    distanceMeters: cumulative[cumulative.length - 1],
    ascendMeters: estimateAscent(coordinates),
    messages: [], // ORS provides no BRouter-style way tags; surface comes from extras.
    surface: surfaceFromSegmentCodes(final.segCodes, cumulative),
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
