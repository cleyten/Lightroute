// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseTcx } from './tcximport';

const tcx = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">${body}</TrainingCenterDatabase>`;

const point = (lat: number, lon: number, ele = 12) =>
  `<Trackpoint><Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lon}</LongitudeDegrees></Position><AltitudeMeters>${ele}</AltitudeMeters></Trackpoint>`;

describe('parseTcx', () => {
  it('reads a Course as [lon, lat, ele]', () => {
    const coords = parseTcx(
      tcx(`<Courses><Course><Track>${point(51.44, 5.47, 18)}${point(51.45, 5.48, 21)}</Track></Course></Courses>`),
    );
    expect(coords).toEqual([
      [5.47, 51.44, 18],
      [5.48, 51.45, 21],
    ]);
  });

  it('reads a recorded Activity the same way', () => {
    const coords = parseTcx(
      tcx(`<Activities><Activity><Lap><Track>${point(51.44, 5.47)}${point(51.45, 5.48)}</Track></Lap></Activity></Activities>`),
    );
    expect(coords).toHaveLength(2);
  });

  it('ignores CoursePoint turn markers', () => {
    const coords = parseTcx(
      tcx(
        `<Courses><Course><Track>${point(51.44, 5.47)}${point(51.45, 5.48)}</Track>` +
          `<CoursePoint><Name>Left</Name><PointType>Left</PointType></CoursePoint></Course></Courses>`,
      ),
    );
    expect(coords).toHaveLength(2);
  });

  it('drops paused trackpoints that carry no Position', () => {
    const coords = parseTcx(
      tcx(
        `<Activities><Activity><Lap><Track>` +
          point(51.44, 5.47) +
          `<Trackpoint><AltitudeMeters>12</AltitudeMeters></Trackpoint>` +
          point(51.46, 5.49) +
          `</Track></Lap></Activity></Activities>`,
      ),
    );
    expect(coords).toHaveLength(2);
    expect(coords.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))).toBe(true);
  });

  it('defaults a missing altitude to zero', () => {
    const coords = parseTcx(
      tcx(
        `<Courses><Course><Track>` +
          `<Trackpoint><Position><LatitudeDegrees>51.44</LatitudeDegrees><LongitudeDegrees>5.47</LongitudeDegrees></Position></Trackpoint>` +
          `<Trackpoint><Position><LatitudeDegrees>51.45</LatitudeDegrees><LongitudeDegrees>5.48</LongitudeDegrees></Position></Trackpoint>` +
          `</Track></Course></Courses>`,
      ),
    );
    expect(coords.every(([, , ele]) => ele === 0)).toBe(true);
  });

  it('rejects a file that is not XML', () => {
    expect(() => parseTcx('nope')).toThrow(/not a valid TCX/);
  });

  it('rejects a file with too few points', () => {
    expect(() => parseTcx(tcx('<Courses/>'))).toThrow(/No track points/);
  });

  it('rejects a file whose points are all positionless', () => {
    expect(() =>
      parseTcx(tcx('<Activities><Activity><Lap><Track><Trackpoint/><Trackpoint/></Track></Lap></Activity></Activities>')),
    ).toThrow(/No usable/);
  });
});
