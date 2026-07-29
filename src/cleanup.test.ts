import { describe, expect, it } from 'vitest';
import { cleanLoopGeometry, findWiggles } from './cleanup';
import { backtrackReport } from './loops';

const LAT0 = 51.44;
const M_PER_LAT = 6371000 * (Math.PI / 180);
const M_PER_LNG = M_PER_LAT * Math.cos((LAT0 * Math.PI) / 180);

type Coord = [number, number, number];

/** Turns a polyline given in meters east/north of a fixed origin into coords. */
function fromMeters(points: [number, number][]): Coord[] {
  return points.map(([x, y]) => [5.47 + x / M_PER_LNG, LAT0 + y / M_PER_LAT, 0]);
}

/** Straight line from a to b, with a vertex every `stepM` meters. */
function line(a: [number, number], b: [number, number], stepM = 25): [number, number][] {
  const steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepM));
  return Array.from({ length: steps + 1 }, (_, s): [number, number] => [
    a[0] + ((b[0] - a[0]) * s) / steps,
    a[1] + ((b[1] - a[1]) * s) / steps,
  ]);
}

/** A closed square route of `side` meters, as a list of corner-to-corner runs. */
function squareSides(side: number): [number, number][][] {
  return [
    line([side, 0], [side, side]),
    line([side, side], [0, side]),
    line([0, side], [0, 0]),
  ];
}

function totalMeters(coords: Coord[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * M_PER_LNG;
    const dy = (coords[i][1] - coords[i - 1][1]) * M_PER_LAT;
    sum += Math.hypot(dx, dy);
  }
  return sum;
}

describe('cleanLoopGeometry', () => {
  it('leaves a clean loop untouched', () => {
    const loop = fromMeters([line([0, 0], [2000, 0]), ...squareSides(2000)].flat());
    const result = cleanLoopGeometry(loop, null);
    expect(result.removedMeters).toBe(0);
    expect(result.coords).toHaveLength(loop.length);
  });

  it('splices out a retrace made of only a handful of vertices', () => {
    // The shape that used to survive: an exact out-and-back along a straight
    // road needs one vertex out and one back, and the spur test used to demand
    // six before it would look. Measured on real ORS loops, that left 780 m
    // out-and-backs in place.
    const loop = fromMeters(
      [
        line([0, 0], [1000, 0]),
        [
          [1000, 0],
          [1000, 390],
          [1000, 0],
        ] as [number, number][],
        line([1000, 0], [2000, 0]),
        ...squareSides(2000),
      ].flat(),
    );
    const result = cleanLoopGeometry(loop, null);
    expect(result.removedMeters).toBeGreaterThan(700);
    expect(backtrackReport(result.coords).totalMeters).toBe(0);
  });

  it('splices out a U-turn that returns on the road beside the road', () => {
    // Neither of the older passes sees this: the return leg is 25 m to the
    // side, so it is not a palindrome, and the two legs enclose a sliver, which
    // the curl pass spares because that is also the shape of a hairpin.
    const loop = fromMeters(
      [
        line([0, 0], [1000, 0]),
        line([1000, 0], [1000, 400]),
        line([1025, 400], [1025, 0]),
        line([1025, 0], [2000, 0]),
        ...squareSides(2000),
      ].flat(),
    );
    const result = cleanLoopGeometry(loop, null);
    expect(result.removedMeters).toBeGreaterThan(750);
    expect(backtrackReport(result.coords).totalMeters).toBe(0);
    // Nothing beyond a junction's width of straight line is introduced.
    expect(totalMeters(result.coords)).toBeLessThan(totalMeters(loop) - 750);
  });

  it('keeps a hairpin bend, which is a legal shape rather than an artifact', () => {
    const loop = fromMeters(
      [
        line([0, 0], [900, 0]),
        line([900, 0], [1000, 120]),
        line([1000, 120], [820, 260]),
        line([820, 260], [0, 700]),
        line([0, 700], [0, 0]),
      ].flat(),
    );
    expect(cleanLoopGeometry(loop, null).removedMeters).toBe(0);
  });

  it('keeps surface codes in step with the coordinates it splices', () => {
    const loop = fromMeters(
      [
        line([0, 0], [1000, 0]),
        line([1000, 0], [1000, 400]),
        line([1025, 400], [1025, 0]),
        line([1025, 0], [2000, 0]),
        ...squareSides(2000),
      ].flat(),
    );
    const codes = loop.slice(1).map((_, i) => i % 3);
    const result = cleanLoopGeometry(loop, codes);
    expect(result.segCodes).not.toBeNull();
    expect(result.segCodes).toHaveLength(result.coords.length - 1);
  });
});

describe('findWiggles', () => {
  it('finds a detour whose endpoints nearly meet', () => {
    // Out 500 m, a jog sideways, and back to within 120 m of the start: too far
    // apart to splice blind, which is what the re-route through BRouter is for.
    const detour = fromMeters(
      [
        line([0, 0], [500, 0]),
        line([500, 0], [500, 200]),
        line([500, 200], [120, 200]),
        line([120, 200], [120, 0]),
        line([120, 0], [1200, 0]),
      ].flat(),
    );
    const wiggles = findWiggles(detour);
    expect(wiggles.length).toBeGreaterThan(0);
    expect(wiggles[0].pathLen).toBeGreaterThan(wiggles[0].directLen * 2.8);
  });

  it('finds nothing along a straight road', () => {
    expect(findWiggles(fromMeters(line([0, 0], [3000, 0])))).toEqual([]);
  });
});
