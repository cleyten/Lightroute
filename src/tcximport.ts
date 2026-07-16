// Client-side TCX import: reads a .tcx file's track points into the same
// coordinate format the rest of the app already works with. CoursePoint turn
// markers are ignored on import (they only matter for the export navigation
// cues); the browser's built-in DOMParser is enough, no library needed. Same
// technique as gpximport.ts: TCX elements sit in one default XML namespace,
// and plain tag-name querySelectorAll matches across that namespace in
// practice, so no namespace-aware querying is needed.

export function parseTcx(xmlText: string): [number, number, number][] {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('This file is not a valid TCX file.');
  }

  // Works for both a planned Course and a recorded Activity: either way the
  // points live in <Track><Trackpoint> elements, gathered in document order.
  const points = [...doc.querySelectorAll('Trackpoint')];
  if (points.length < 2) {
    throw new Error('No track points found in this TCX file.');
  }

  return points.map((point) => {
    const lat = Number(point.querySelector('Position > LatitudeDegrees')?.textContent);
    const lon = Number(point.querySelector('Position > LongitudeDegrees')?.textContent);
    const eleText = point.querySelector('AltitudeMeters')?.textContent;
    const ele = eleText !== undefined ? Number(eleText) : NaN;
    return [lon, lat, Number.isFinite(ele) ? ele : 0];
  });
}
