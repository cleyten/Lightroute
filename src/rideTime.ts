// Estimated moving time for a route. Lightmile Stack shows a "Time" stat
// everywhere a route or candidate is summarized, but the app has never
// computed one, so this is new: distance and climbing are both real (from
// the routed geometry), turned into a time estimate via a standard
// flat-speed-plus-climbing-penalty heuristic, the same shape used by other
// route planners, rather than an invented number.
import type { BikeType } from './settings';

// Typical unloaded moving speed on flat ground, by bike type.
const BASE_SPEED_KMH: Record<BikeType, number> = {
  race: 26,
  gravel: 20,
  mtb: 16,
};

// Each meter of ascent costs roughly as much time as this many extra flat
// meters would (a common cycling rule of thumb, e.g. used by Naismith-style
// estimators): a 1000 m route with 100 m of climbing rides like ~1.8 km.
const CLIMB_PENALTY_M_PER_M_ASCENT = 8;

/** Estimated moving time in hours for a route of this distance and climbing. */
export function estimateMovingTimeHours(
  distanceKm: number,
  ascendM: number,
  bike: BikeType,
): number {
  const effectiveKm = distanceKm + (ascendM * CLIMB_PENALTY_M_PER_M_ASCENT) / 1000;
  return effectiveKm / BASE_SPEED_KMH[bike];
}

/** Formats hours as "H:MM", matching the mockup's stat style (e.g. "1:38"). */
export function formatRideTime(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
