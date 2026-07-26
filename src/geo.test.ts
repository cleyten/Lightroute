import { describe, expect, it } from 'vitest';
import { bearingDegrees, cumulativeDistances, elevationGain, haversineMeters } from './geo';

describe('haversineMeters', () => {
  it('is zero for a point against itself', () => {
    expect(haversineMeters([5.47, 51.44], [5.47, 51.44])).toBe(0);
  });

  it('matches a known distance', () => {
    // Eindhoven to Amsterdam centre, ~111 km great-circle.
    const d = haversineMeters([5.4697, 51.4416], [4.8952, 52.3702]);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(113_000);
  });

  it('is symmetric', () => {
    const a: [number, number] = [5.4, 51.4];
    const b: [number, number] = [5.6, 51.6];
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it('measures one degree of latitude as about 111 km anywhere', () => {
    const atEquator = haversineMeters([0, 0], [0, 1]);
    const atNL = haversineMeters([5, 51], [5, 52]);
    expect(atEquator).toBeCloseTo(atNL, 0);
    expect(atNL / 1000).toBeCloseTo(111.2, 0);
  });
});

describe('cumulativeDistances', () => {
  it('starts at zero and increases monotonically', () => {
    const cum = cumulativeDistances([
      [5.0, 51.0],
      [5.1, 51.0],
      [5.2, 51.0],
    ]);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeGreaterThan(0);
    expect(cum[2]).toBeGreaterThan(cum[1]);
  });

  it('returns one entry per coordinate', () => {
    const coords: [number, number][] = Array.from({ length: 7 }, (_, i) => [5 + i * 0.01, 51]);
    expect(cumulativeDistances(coords)).toHaveLength(7);
  });

  it('sums the individual legs', () => {
    const coords: [number, number][] = [
      [5.0, 51.0],
      [5.1, 51.0],
      [5.1, 51.1],
    ];
    const expected =
      haversineMeters(coords[0], coords[1]) + haversineMeters(coords[1], coords[2]);
    expect(cumulativeDistances(coords)[2]).toBeCloseTo(expected, 6);
  });

  it('handles a single point', () => {
    expect(cumulativeDistances([[5, 51]])).toEqual([0]);
  });
});

describe('bearingDegrees', () => {
  it('reads 0 due north and 90 due east', () => {
    expect(bearingDegrees([5, 51], [5, 52])).toBeCloseTo(0, 1);
    expect(bearingDegrees([5, 51], [6, 51])).toBeCloseTo(90, 0);
  });

  it('reads 180 due south and 270 due west', () => {
    expect(bearingDegrees([5, 51], [5, 50])).toBeCloseTo(180, 1);
    expect(bearingDegrees([5, 51], [4, 51])).toBeCloseTo(270, 0);
  });

  it('always returns a value in [0, 360)', () => {
    for (const [dLng, dLat] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -1]]) {
      const b = bearingDegrees([5, 51], [5 + dLng, 51 + dLat]);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe('elevationGain', () => {
  it('is zero on flat ground', () => {
    expect(elevationGain([[5, 51, 10], [5.1, 51, 10], [5.2, 51, 10]])).toBe(0);
  });

  it('sums a steady climb', () => {
    expect(elevationGain([[5, 51, 0], [5, 51, 50], [5, 51, 120]])).toBeCloseTo(120, 6);
  });

  it('ignores a pure descent', () => {
    expect(elevationGain([[5, 51, 200], [5, 51, 100], [5, 51, 0]])).toBe(0);
  });

  it('counts only the climbing half of a there-and-back profile', () => {
    expect(elevationGain([[5, 51, 0], [5, 51, 80], [5, 51, 0]])).toBeCloseTo(80, 6);
  });

  it('filters sub-2m jitter instead of accumulating it', () => {
    // A hundred 1m wobbles must not read as 50m of climbing.
    const coords: [number, number, number][] = Array.from(
      { length: 100 },
      (_, i) => [5, 51, i % 2 === 0 ? 10 : 11],
    );
    expect(elevationGain(coords)).toBe(0);
  });

  it('is direction-dependent, which is why routes recompute it on reverse', () => {
    const up: [number, number, number][] = [[5, 51, 0], [5, 51, 30], [5, 51, 10]];
    const down = [...up].reverse();
    expect(elevationGain(up)).toBeCloseTo(30, 6);
    expect(elevationGain(down)).toBeCloseTo(20, 6);
  });

  it('handles an empty track', () => {
    expect(elevationGain([])).toBe(0);
  });
});
