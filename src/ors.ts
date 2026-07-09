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

export async function fetchRoundTrip(
  start: LngLat,
  lengthMeters: number,
  bike: string,
): Promise<RouteResult> {
  if (!ORS_KEY) {
    throw new Error('Geen OpenRouteService-sleutel geconfigureerd (VITE_ORS_KEY).');
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
          points: 4,
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
    throw new Error('Er kwam geen rondrit terug van de routeserver.');
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
    return 'De OpenRouteService-sleutel werd geweigerd. Controleer de sleutel of de domeinbeperking.';
  }
  if (status === 429) {
    return 'Het dagelijkse quotum van OpenRouteService is bereikt. Probeer het morgen opnieuw.';
  }
  if (/2004/.test(body)) {
    return 'De gevraagde afstand is te groot voor een rondrit (maximaal 100 km).';
  }
  return `Rondrit genereren mislukt (fout ${status}).`;
}
