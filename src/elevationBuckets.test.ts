import { describe, expect, it } from 'vitest';
import { bucketElevation, coordinateIndexAtDistance } from './elevationBuckets';

/**
 * Builds a track along a line of latitude with a given elevation profile.
 * `profile` maps a 0..1 position along the track to an elevation in meters.
 */
function track(lengthM: number, profile: (t: number) => number, steps = 400) {
  const dLng = lengthM / (111_320 * Math.cos((51.44 * Math.PI) / 180));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return [5.47 + dLng * t, 51.44, profile(t)] as [number, number, number];
  });
}

describe('bucketElevation', () => {
  it('returns one bucket per requested count', () => {
    const buckets = bucketElevation(track(10000, (t) => 50 * t), 20);
    expect(buckets).toHaveLength(20);
  });

  it('rises from low to high heightFrac on a steady climb', () => {
    const buckets = bucketElevation(track(10000, (t) => 100 * t), 10);
    expect(buckets[0].heightFrac).toBeLessThan(buckets[9].heightFrac);
    // Last bucket's midpoint sits at t=0.95, not the very end of the track.
    expect(buckets[9].heightFrac).toBeCloseTo(0.95, 1);
  });

  it('colors a climbing bucket differently from a flat one', () => {
    const buckets = bucketElevation(
      track(2000, (t) => (t < 0.5 ? 0 : 80 * (t - 0.5) * 2)),
      2,
    );
    expect(buckets[0].gradePct).toBeCloseTo(0, 0);
    expect(buckets[1].gradePct).toBeGreaterThan(5);
    expect(buckets[0].color).not.toBe(buckets[1].color);
  });

  it('never returns a zero-height bar, even on completely flat ground', () => {
    const buckets = bucketElevation(track(5000, () => 10), 15);
    for (const bucket of buckets) expect(bucket.heightFrac).toBeGreaterThan(0);
  });

  it('handles tracks too short to bucket', () => {
    expect(bucketElevation([], 10)).toEqual([]);
    expect(bucketElevation([[5, 51, 0]], 10)).toEqual([]);
  });
});

describe('coordinateIndexAtDistance', () => {
  it('finds the nearest index at or after a target distance', () => {
    const distances = [0, 100, 250, 400, 1000];
    expect(coordinateIndexAtDistance(distances, 0)).toBe(0);
    expect(coordinateIndexAtDistance(distances, 260)).toBe(3);
    expect(coordinateIndexAtDistance(distances, 1000)).toBe(4);
    expect(coordinateIndexAtDistance(distances, 5000)).toBe(4);
  });
});
