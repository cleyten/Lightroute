// Bucketed elevation data for the bar-style profile charts used throughout
// the Lightmile Stack redesign (the full elevation chart, the mini bars on
// candidate cards, the desktop sidebar). Pure data, no DOM and no Chart.js,
// so it can be shared by chart.ts (lazy-loaded) and candidateCards.ts
// (eagerly loaded) without pulling either into the other's bundle.
import { cumulativeDistances } from './geo';
import { gradeColor } from './gradelegend';

export interface ElevationBucket {
  /** Elevation normalized 0..1 against this track's own min/max. */
  heightFrac: number;
  /** Elevation at the bucket's midpoint, in meters (for tooltips/labels). */
  elevationM: number;
  /** Average grade (percent) climbed/descended across the bucket. */
  gradePct: number;
  color: string;
}

// A flat run still needs a visible bar (the mockup's bars never go near
// zero height), so heights are floored rather than allowed to hit 0.
const MIN_HEIGHT_FRAC = 0.12;

/**
 * Splits a track into `bucketCount` equal-distance buckets. Each bucket's
 * height reflects elevation at its midpoint (normalized to the track's own
 * min/max), and its color reflects the grade climbed/descended across it,
 * via the same `gradeColor()` used by the legend and climb badges.
 */
export function bucketElevation(
  coordinates: [number, number, number][],
  bucketCount: number,
): ElevationBucket[] {
  if (coordinates.length < 2 || bucketCount < 1) return [];

  const distances = cumulativeDistances(coordinates);
  const total = distances[distances.length - 1];
  const elevations = coordinates.map((c) => c[2] ?? 0);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const range = maxEle - minEle || 1;

  if (total <= 0) {
    return Array.from({ length: bucketCount }, () => ({
      heightFrac: MIN_HEIGHT_FRAC,
      elevationM: elevations[0] ?? 0,
      gradePct: 0,
      color: gradeColor(0),
    }));
  }

  const elevationAt = (targetM: number): number => {
    const clamped = Math.max(0, Math.min(total, targetM));
    let i = 1;
    while (i < distances.length - 1 && distances[i] < clamped) i++;
    const d0 = distances[i - 1];
    const d1 = distances[i];
    const e0 = elevations[i - 1];
    const e1 = elevations[i];
    if (d1 === d0) return e1;
    return e0 + (e1 - e0) * ((clamped - d0) / (d1 - d0));
  };

  const buckets: ElevationBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const startM = (total * i) / bucketCount;
    const endM = (total * (i + 1)) / bucketCount;
    const eleStart = elevationAt(startM);
    const eleEnd = elevationAt(endM);
    const eleMid = elevationAt((startM + endM) / 2);
    const gradePct = endM > startM ? ((eleEnd - eleStart) / (endM - startM)) * 100 : 0;
    buckets.push({
      heightFrac: Math.max(MIN_HEIGHT_FRAC, (eleMid - minEle) / range),
      elevationM: eleMid,
      gradePct,
      color: gradeColor(gradePct),
    });
  }
  return buckets;
}

/** Index into `distances` (from `cumulativeDistances`) nearest a target distance in meters. */
export function coordinateIndexAtDistance(distances: number[], targetM: number): number {
  let lo = 0;
  let hi = distances.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] < targetM) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
