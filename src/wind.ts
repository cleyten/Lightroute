// Current wind at the start point via Open-Meteo (free, no API key).
// Used to describe each loop (headwind out or home?) and to prefer loops
// that ride into the wind first, so the way home has a tailwind.

export interface WindInfo {
  /** Wind speed in km/h. */
  speedKmh: number;
  /** Meteorological direction: where the wind blows FROM, in degrees. */
  fromDeg: number;
}

export async function fetchWind(point: [number, number]): Promise<WindInfo | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${point[1].toFixed(4)}` +
    `&longitude=${point[0].toFixed(4)}` +
    `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    const current = data?.current;
    if (typeof current?.wind_speed_10m !== 'number') return null;
    return { speedKmh: current.wind_speed_10m, fromDeg: current.wind_direction_10m ?? 0 };
  } catch {
    return null;
  }
}

/** Smallest absolute angle between two bearings, 0..180 degrees. */
export function angleBetween(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compassLabel(fromDeg: number): string {
  return COMPASS[Math.round(fromDeg / 45) % 8];
}

/**
 * Describes how a loop relates to the current wind, given the mean travel
 * bearing of its first part. Returns null in (near) calm conditions.
 */
export function windNote(wind: WindInfo, outboundBearing: number): string | null {
  if (wind.speedKmh < 9) return null;
  const diff = angleBetween(outboundBearing, wind.fromDeg);
  if (diff < 65) return 'headwind out, tailwind home';
  if (diff > 115) return 'tailwind out, headwind home';
  return 'mostly crosswind';
}

/**
 * Scoring bonus (-0.25..0.25) for heading into the wind first. Scales with
 * wind speed; irrelevant on calm days.
 */
export function windBonus(wind: WindInfo | null, outboundBearing: number): number {
  if (!wind || wind.speedKmh < 5) return 0;
  const diff = angleBetween(outboundBearing, wind.fromDeg);
  const alignment = Math.cos((diff * Math.PI) / 180); // 1 = straight into the wind
  return alignment * Math.min(wind.speedKmh, 25) / 25 * 0.25;
}
