import { describe, expect, it } from 'vitest';
import { detectClimbs } from './climbs';

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

describe('detectClimbs', () => {
  it('finds nothing on flat ground', () => {
    expect(detectClimbs(track(5000, () => 10))).toEqual([]);
  });

  it('finds nothing on a descent', () => {
    expect(detectClimbs(track(5000, (t) => 200 - 150 * t))).toEqual([]);
  });

  it('finds exactly one climb on a steady 1 km at 4%', () => {
    // 1 km climbing at 4%, then 2 km flat.
    const climbs = detectClimbs(
      track(3000, (t) => (t < 1 / 3 ? 40 * (t * 3) : 40)),
    );
    expect(climbs).toHaveLength(1);
    expect(climbs[0].gainM).toBeGreaterThan(30);
    expect(climbs[0].avgPct).toBeGreaterThan(2.5);
    expect(climbs[0].avgPct).toBeLessThan(5.5);
  });

  it('does not swallow the plateau after a climb', () => {
    // This is the bug the gradient-run rewrite fixed: growing to the highest
    // point would extend the climb across the flat and dilute its grade.
    const climbs = detectClimbs(track(4000, (t) => (t < 0.25 ? 60 * (t * 4) : 60)));
    expect(climbs).toHaveLength(1);
    expect(climbs[0].lengthM).toBeLessThan(1600);
    expect(climbs[0].avgPct).toBeGreaterThan(3);
  });

  it('ignores a rise too small to matter', () => {
    // 8 m over 2 km is under both the gain and the average-grade floor.
    expect(detectClimbs(track(2000, (t) => 8 * t))).toEqual([]);
  });

  it('separates two climbs split by a long descent', () => {
    const climbs = detectClimbs(
      track(8000, (t) => {
        if (t < 0.2) return 200 * t; // up to 40 m
        if (t < 0.5) return 40 - 130 * (t - 0.2); // down to ~1 m over 2.4 km
        if (t < 0.7) return 1 + 200 * (t - 0.5); // up to ~41 m
        return 41;
      }),
    );
    expect(climbs).toHaveLength(2);
    expect(climbs[0].startKm).toBeLessThan(climbs[1].startKm);
  });

  it('reports a max grade at least as steep as the average', () => {
    const climbs = detectClimbs(track(3000, (t) => (t < 1 / 3 ? 40 * (t * 3) : 40)));
    expect(climbs[0].maxPct).toBeGreaterThanOrEqual(climbs[0].avgPct);
  });

  it('returns indices that address the original coordinate array', () => {
    const coords = track(3000, (t) => (t < 1 / 3 ? 40 * (t * 3) : 40));
    const [climb] = detectClimbs(coords);
    expect(climb.startIndex).toBeGreaterThanOrEqual(0);
    expect(climb.endIndex).toBeLessThan(coords.length);
    expect(climb.startIndex).toBeLessThan(climb.endIndex);
  });

  it('handles tracks too short to analyse', () => {
    expect(detectClimbs([])).toEqual([]);
    expect(detectClimbs([[5, 51, 0], [5.001, 51, 10]])).toEqual([]);
  });
});
