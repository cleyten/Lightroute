// Client-side GPX import: reads a .gpx file's track (or route) points into the
// same coordinate format the rest of the app already works with, using the
// browser's built-in DOMParser (no library needed). GPX elements use a default
// XML namespace, but unprefixed attributes (lat/lon) have no namespace of
// their own, so plain getAttribute()/querySelectorAll() by tag name works.

import { haversineMeters } from './geo';
import { isPlausibleLonLat } from './waypoints';

export function parseGpx(xmlText: string): [number, number, number][] {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('This file is not a valid GPX file.');
  }

  // Prefer the recorded track; some route planners export <rte> (a coarse
  // waypoint list) instead, so fall back to that.
  let points = [...doc.querySelectorAll('trkpt')];
  if (points.length === 0) points = [...doc.querySelectorAll('rtept')];
  if (points.length < 2) {
    throw new Error('No track or route points found in this GPX file.');
  }

  // Absence has to be detected on the attribute, not on the parsed number:
  // getAttribute returns null for a missing lat, Number(null) is 0, and 0 is a
  // perfectly valid latitude. A point missing only its lat would otherwise
  // survive as a plausible-looking coordinate on the equator.
  const coords = points
    .map((point): [number, number, number] | null => {
      const latAttr = point.getAttribute('lat');
      const lonAttr = point.getAttribute('lon');
      if (latAttr === null || lonAttr === null || latAttr === '' || lonAttr === '') return null;
      const lat = Number(latAttr);
      const lon = Number(lonAttr);
      if (!isPlausibleLonLat(lon, lat)) return null;
      const eleText = point.querySelector('ele')?.textContent;
      const ele = eleText !== undefined && eleText !== null ? Number(eleText) : NaN;
      return [lon, lat, Number.isFinite(ele) ? ele : 0];
    })
    .filter((coord): coord is [number, number, number] => coord !== null);

  if (coords.length < 2) {
    throw new Error('No usable track or route points found in this GPX file.');
  }
  return coords;
}

/** A track is treated as a loop when its ends are within this distance (meters). */
const LOOP_CLOSE_M = 100;

export function isClosedTrack(coords: [number, number, number][]): boolean {
  const meters = haversineMeters(coords[0], coords[coords.length - 1]);
  return meters <= LOOP_CLOSE_M;
}
