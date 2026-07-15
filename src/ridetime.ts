// Rough ride-time estimate: distance at a rider-set average speed, plus a
// simple allowance for climbing effort. This is a heuristic (roughly 1 extra
// hour per 400 m of ascent, a commonly used cycling rule of thumb), not a
// physical model — it deliberately stays simple and transparent.

const CLIMB_METERS_PER_HOUR = 400;

export function estimateRideTimeHours(
  distanceMeters: number,
  ascendMeters: number,
  avgSpeedKmh: number,
): number {
  if (avgSpeedKmh <= 0) return 0;
  const flatHours = distanceMeters / 1000 / avgSpeedKmh;
  const climbHours = ascendMeters / CLIMB_METERS_PER_HOUR;
  return flatHours + climbHours;
}

/** Formats hours as "45 min", "2 h" or "2h 15m". */
export function formatDuration(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h}h ${m}m`;
}
