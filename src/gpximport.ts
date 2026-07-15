// Client-side GPX import: reads a .gpx file's track (or route) points into the
// same coordinate format the rest of the app already works with, using the
// browser's built-in DOMParser (no library needed). GPX elements use a default
// XML namespace, but unprefixed attributes (lat/lon) have no namespace of
// their own, so plain getAttribute()/querySelectorAll() by tag name works.

import { haversineMeters } from './geo';

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

  return points.map((point) => {
    const lat = Number(point.getAttribute('lat'));
    const lon = Number(point.getAttribute('lon'));
    const eleText = point.querySelector('ele')?.textContent;
    const ele = eleText !== undefined ? Number(eleText) : NaN;
    return [lon, lat, Number.isFinite(ele) ? ele : 0];
  });
}

/** A track is treated as a loop when its ends are within this distance (meters). */
const LOOP_CLOSE_M = 100;

export function isClosedTrack(coords: [number, number, number][]): boolean {
  const meters = haversineMeters(coords[0], coords[coords.length - 1]);
  return meters <= LOOP_CLOSE_M;
}
