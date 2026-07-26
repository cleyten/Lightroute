// Validation for waypoint lists arriving from outside the app: share links,
// IndexedDB records written by an older version, and community rows from
// Supabase (where `waypoints` is unvalidated jsonb, so a hostile or buggy
// client can store any shape at all).
//
// Everything downstream assumes finite [lng, lat] pairs. Without a guard, one
// bad list turns into NaN coordinates that throw inside maplibre's LngLatBounds
// or silently place a point at Null Island.

import type { LngLat } from './routing';

/** Beyond this a "route" is not a route; it is someone probing the database. */
const MAX_WAYPOINTS = 500;

function isLngLat(value: unknown): value is LngLat {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [lng, lat] = value;
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

/**
 * True when a parsed coordinate is usable as a real position.
 *
 * Rejects [0, 0] as well as out-of-range values: a GPX point missing its `lat`
 * attribute yields Number(null) === 0, so Null Island is nearly always a
 * parsing artefact rather than somewhere anybody cycled.
 */
export function isPlausibleLonLat(lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return false;
  return !(lon === 0 && lat === 0);
}

/** True when `value` is a routable list of at least two valid [lng, lat] pairs. */
export function isValidWaypoints(value: unknown): value is LngLat[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_WAYPOINTS &&
    value.every(isLngLat)
  );
}

/**
 * Returns a fresh, trimmed copy of `value` when it is a valid waypoint list,
 * otherwise null. Copying matters: callers mutate waypoints (drag, insert,
 * remove) and must not write back into a stored record.
 */
export function sanitizeWaypoints(value: unknown): LngLat[] | null {
  if (!isValidWaypoints(value)) return null;
  return value.map(([lng, lat]) => [lng, lat] as LngLat);
}
