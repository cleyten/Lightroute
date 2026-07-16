// Small geodesic helpers. Coordinates are [longitude, latitude(, elevation)].

type Coord = [number, number] | [number, number, number];

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(a: Coord, b: Coord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Running distance along a track, in meters, starting at 0. */
export function cumulativeDistances(coords: Coord[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(out[i - 1] + haversineMeters(coords[i - 1], coords[i]));
  }
  return out;
}

/** Compass bearing from a to b, in degrees clockwise from north (0-360). */
export function bearingDegrees(a: Coord, b: Coord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Total positive elevation gain over a track, ignoring sub-2m jitter.
 * Recomputed after reversing a route, since a descent one way is a climb
 * the other way, so the gain is direction-dependent.
 */
export function elevationGain(coords: [number, number, number][]): number {
  let gain = 0;
  let reference = coords[0]?.[2] ?? 0;
  for (const [, , elevation] of coords) {
    const value = elevation ?? reference;
    const delta = value - reference;
    if (delta >= 2) {
      gain += delta;
      reference = value;
    } else if (delta <= -2) {
      reference = value;
    }
  }
  return gain;
}
