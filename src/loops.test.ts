import { describe, expect, it } from 'vitest';
import {
  backtrackReport,
  edgeSet,
  initialBearing,
  loopRoundness,
  overlapRatio,
  projectToMeters,
  resample,
  routeSimilarity,
} from './loops';

/** A closed square loop of roughly `sideM` meters per side, near Eindhoven. */
function square(sideM: number, steps = 40): [number, number][] {
  const lat0 = 51.44;
  const dLat = sideM / 111_320;
  const dLng = sideM / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const corners: [number, number][] = [
    [5.47, lat0],
    [5.47 + dLng, lat0],
    [5.47 + dLng, lat0 + dLat],
    [5.47, lat0 + dLat],
    [5.47, lat0],
  ];
  const out: [number, number][] = [];
  for (let i = 1; i < corners.length; i++) {
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([
        corners[i - 1][0] + (corners[i][0] - corners[i - 1][0]) * t,
        corners[i - 1][1] + (corners[i][1] - corners[i - 1][1]) * t,
      ]);
    }
  }
  out.push(corners[corners.length - 1]);
  return out;
}

/** A straight line out and back along the same ground. */
function outAndBack(lengthM: number, steps = 80): [number, number][] {
  const dLng = lengthM / (111_320 * Math.cos((51.44 * Math.PI) / 180));
  const out: [number, number][] = [];
  for (let s = 0; s <= steps; s++) out.push([5.47 + (dLng * s) / steps, 51.44]);
  for (let s = steps - 1; s >= 0; s--) out.push([5.47 + (dLng * s) / steps, 51.44]);
  return out;
}

const LAT0 = 51.44;
const M_PER_LAT = 6371000 * (Math.PI / 180);
const M_PER_LNG = M_PER_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** Turns a polyline given in meters east/north of a fixed origin into coords. */
function fromMeters(points: [number, number][]): [number, number][] {
  return points.map(([x, y]) => [5.47 + x / M_PER_LNG, LAT0 + y / M_PER_LAT]);
}

/** Straight line from a to b, with a vertex every `stepM` meters. */
function line(a: [number, number], b: [number, number], stepM = 20): [number, number][] {
  const steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepM));
  return Array.from({ length: steps + 1 }, (_, s) => [
    a[0] + ((b[0] - a[0]) * s) / steps,
    a[1] + ((b[1] - a[1]) * s) / steps,
  ]);
}

describe('projectToMeters', () => {
  it('preserves distance to within a percent at loop scale', () => {
    const pts = projectToMeters([[5.47, 51.44], [5.47, 51.45]]);
    const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });
});

describe('resample', () => {
  it('returns points spaced at roughly the requested interval', () => {
    const line: [number, number][] = [[0, 0], [1000, 0]];
    const out = resample(line, 100);
    expect(out.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < out.length; i++) {
      expect(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])).toBeCloseTo(100, 6);
    }
  });

  it('passes through lists too short to resample', () => {
    expect(resample([[0, 0]], 100)).toEqual([[0, 0]]);
    expect(resample([], 100)).toEqual([]);
  });
});

describe('overlapRatio', () => {
  it('is near zero for a clean loop', () => {
    expect(overlapRatio(square(2000))).toBeLessThan(0.05);
  });

  it('is near a half for a full out-and-back', () => {
    const ratio = overlapRatio(outAndBack(2000));
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it('lands in between when a loop has a there-and-back spur', () => {
    const loop = square(2000);
    const spur = outAndBack(400, 20);
    const ratio = overlapRatio([...loop, ...spur]);
    expect(ratio).toBeGreaterThan(0.03);
    expect(ratio).toBeLessThan(0.4);
  });

  it('returns 0 rather than throwing on a degenerate route', () => {
    expect(overlapRatio([[5, 51], [5, 51]])).toBe(0);
  });
});

describe('backtrackReport', () => {
  it('finds nothing in a clean loop', () => {
    expect(backtrackReport(square(2000))).toEqual({ totalMeters: 0, longestMeters: 0 });
  });

  it('reports almost the whole distance of a full out-and-back', () => {
    // Each leg registers up to within half the separation of the turn.
    const report = backtrackReport(outAndBack(2000));
    expect(report.totalMeters).toBeGreaterThan(3500);
  });

  it('catches a U-turn that comes back on the road beside the road', () => {
    // The case overlapRatio is blind to: the return leg is 25 m to the side, so
    // it lands in different grid cells and never counts as a repeat. Measured
    // over real ORS loops, overlapRatio stays under 0.01 while this reports
    // hundreds of meters, which is why the quality gate uses this instead.
    const loop = fromMeters([
      ...line([0, 0], [1000, 0]),
      ...line([1000, 0], [1000, 300]),
      ...line([1025, 300], [1025, 0]),
      ...line([1025, 0], [2000, 0]),
      ...line([2000, 0], [2000, 2000]),
      ...line([2000, 2000], [0, 2000]),
      ...line([0, 2000], [0, 0]),
    ]);
    expect(overlapRatio(loop)).toBeLessThan(0.02);

    const report = backtrackReport(loop);
    expect(report.longestMeters).toBeGreaterThan(150);
    expect(report.totalMeters).toBeGreaterThan(300);
  });

  it('leaves an honest hairpin bend alone', () => {
    // A switchback: the legs touch at the apex and separate quickly, so there
    // is no stretch of riding beside itself.
    const hairpin = fromMeters([
      ...line([0, 0], [200, 0]),
      ...line([200, 0], [180, 30]),
      ...line([180, 30], [0, 140]),
    ]);
    expect(backtrackReport(hairpin)).toEqual({ totalMeters: 0, longestMeters: 0 });
  });

  it('does not count a loop closing where it started', () => {
    const closed = square(1200);
    expect(backtrackReport([...closed, closed[0]]).totalMeters).toBe(0);
  });

  it('returns zeroes rather than throwing on a degenerate route', () => {
    expect(backtrackReport([[5, 51], [5, 51]])).toEqual({ totalMeters: 0, longestMeters: 0 });
  });
});

describe('loopRoundness', () => {
  it('rates a square well below a circle but clearly above zero', () => {
    const side = 2000;
    const r = loopRoundness(square(side), side * 4);
    // A square's isoperimetric quotient is pi/4 ~ 0.785.
    expect(r).toBeGreaterThan(0.7);
    expect(r).toBeLessThan(0.85);
  });

  it('rates an out-and-back near zero, since it encloses no area', () => {
    expect(loopRoundness(outAndBack(2000), 4000)).toBeLessThan(0.01);
  });

  it('guards against a zero perimeter', () => {
    expect(loopRoundness(square(1000), 0)).toBe(0);
  });
});

describe('initialBearing', () => {
  it('reads north for a route heading north', () => {
    const pts: [number, number][] = Array.from({ length: 30 }, (_, i) => [5.47, 51.44 + i * 0.002]);
    expect(initialBearing(pts)).toBeCloseTo(0, 0);
  });

  it('reads east for a route heading east', () => {
    const pts: [number, number][] = Array.from({ length: 30 }, (_, i) => [5.47 + i * 0.002, 51.44]);
    expect(initialBearing(pts)).toBeCloseTo(90, 0);
  });
});

describe('routeSimilarity', () => {
  it('is 1 for a route against itself', () => {
    const edges = edgeSet(square(2000));
    expect(routeSimilarity(edges, edges)).toBeCloseTo(1, 6);
  });

  it('is 0 for routes in different places', () => {
    const here = edgeSet(square(2000));
    const far = edgeSet(square(2000).map(([lng, lat]) => [lng + 0.5, lat + 0.5] as [number, number]));
    expect(routeSimilarity(here, far)).toBe(0);
  });

  it('is 0 when either side is empty', () => {
    expect(routeSimilarity(new Set(), edgeSet(square(2000)))).toBe(0);
  });

  it('is symmetric', () => {
    const a = edgeSet(square(2000));
    const b = edgeSet(square(2400));
    expect(routeSimilarity(a, b)).toBeCloseTo(routeSimilarity(b, a), 12);
  });
});
