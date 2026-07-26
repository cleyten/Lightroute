// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isClosedTrack, parseGpx } from './gpximport';

const gpx = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

const trk = (points: string) => `<trk><name>Test</name><trkseg>${points}</trkseg></trk>`;

describe('parseGpx', () => {
  it('reads track points in order, as [lon, lat, ele]', () => {
    const coords = parseGpx(
      gpx(
        trk(`
        <trkpt lat="51.4416" lon="5.4697"><ele>18.2</ele></trkpt>
        <trkpt lat="51.4500" lon="5.4800"><ele>21.0</ele></trkpt>
        <trkpt lat="51.4600" lon="5.4900"><ele>25.5</ele></trkpt>`),
      ),
    );
    expect(coords).toEqual([
      [5.4697, 51.4416, 18.2],
      [5.48, 51.45, 21],
      [5.49, 51.46, 25.5],
    ]);
  });

  it('defaults a missing elevation to zero rather than NaN', () => {
    const coords = parseGpx(
      gpx(trk('<trkpt lat="51.44" lon="5.47"/><trkpt lat="51.45" lon="5.48"/>')),
    );
    expect(coords.every(([, , ele]) => ele === 0)).toBe(true);
  });

  it('falls back to route points when there is no track', () => {
    const coords = parseGpx(
      gpx('<rte><rtept lat="51.44" lon="5.47"/><rtept lat="51.45" lon="5.48"/></rte>'),
    );
    expect(coords).toHaveLength(2);
    expect(coords[0][0]).toBe(5.47);
  });

  it('prefers the track when a file carries both', () => {
    const coords = parseGpx(
      gpx(
        '<rte><rtept lat="1" lon="1"/><rtept lat="2" lon="2"/></rte>' +
          trk('<trkpt lat="51.44" lon="5.47"/><trkpt lat="51.45" lon="5.48"/>'),
      ),
    );
    expect(coords[0]).toEqual([5.47, 51.44, 0]);
  });

  it('drops points with a missing lat/lon instead of placing them at Null Island', () => {
    const coords = parseGpx(
      gpx(
        trk(`
        <trkpt lat="51.44" lon="5.47"/>
        <trkpt lon="5.48"/>
        <trkpt lat="51.46" lon="5.49"/>`),
      ),
    );
    expect(coords).toHaveLength(2);
    expect(coords.some(([lon, lat]) => lon === 0 && lat === 0)).toBe(false);
  });

  it('rejects a file that is not XML at all', () => {
    expect(() => parseGpx('this is not xml')).toThrow(/not a valid GPX/);
  });

  it('rejects a file with too few points', () => {
    expect(() => parseGpx(gpx(trk('<trkpt lat="51.44" lon="5.47"/>')))).toThrow(/No track/);
    expect(() => parseGpx(gpx('<metadata/>'))).toThrow(/No track/);
  });

  it('rejects a file whose only points are unusable', () => {
    expect(() => parseGpx(gpx(trk('<trkpt/><trkpt/>')))).toThrow(/No usable/);
  });
});

describe('isClosedTrack', () => {
  it('is true when the ends meet', () => {
    expect(isClosedTrack([[5.47, 51.44, 0], [5.5, 51.46, 0], [5.47, 51.44, 0]])).toBe(true);
  });

  it('is true within the 100 m tolerance', () => {
    // ~50 m north of the start.
    expect(isClosedTrack([[5.47, 51.44, 0], [5.5, 51.46, 0], [5.47, 51.44045, 0]])).toBe(true);
  });

  it('is false for an open track', () => {
    expect(isClosedTrack([[5.47, 51.44, 0], [5.5, 51.46, 0], [5.6, 51.5, 0]])).toBe(false);
  });
});
