// Turn-by-turn cue sheet derived purely from route geometry. Neither BRouter
// nor the round-trip flow gives real turn instructions here (BRouter has none
// in this response format; ORS round trips are fetched with instructions
// disabled), so cues are detected from bearing changes along the final route
// coordinates instead. That works identically for manual routes and
// generated loops, needs no extra API call, and stays within the project's
// "no paid services" constraint.
//
// This is a heuristic, not real navigation data: it has no street names and
// can occasionally flag a wide, gentle road bend as a "slight" turn.

import { cumulativeDistances } from './geo';

export type TurnKind = 'sharp-left' | 'left' | 'slight-left' | 'slight-right' | 'right' | 'sharp-right';

export interface Cue {
  atKm: number;
  turn: TurnKind;
  lngLat: [number, number];
}

/** Bearing is measured over this distance before/after each candidate vertex. */
const BASELINE_M = 70;
/** Bearing changes smaller than this are ignored (noisy OSM geometry, not a real turn). */
const MIN_TURN_DEG = 25;
/** Cues closer together than this are merged into one (same junction). */
const MIN_GAP_M = 120;

export function buildCueSheet(coordinates: [number, number, number][]): Cue[] {
  if (coordinates.length < 3) return [];
  const cum = cumulativeDistances(coordinates);
  const total = cum[cum.length - 1];
  if (total < BASELINE_M * 3) return [];

  const cues: Cue[] = [];
  let lastCueDist = -Infinity;
  for (let i = 1; i < coordinates.length - 1; i++) {
    const backIdx = indexBefore(cum, i);
    const fwdIdx = indexAfter(cum, i);
    if (backIdx === i || fwdIdx === i) continue;

    const bearingIn = bearingDeg(coordinates[backIdx], coordinates[i]);
    const bearingOut = bearingDeg(coordinates[i], coordinates[fwdIdx]);
    const delta = signedTurnDeg(bearingIn, bearingOut);
    if (Math.abs(delta) < MIN_TURN_DEG) continue;
    if (cum[i] - lastCueDist < MIN_GAP_M) continue;

    cues.push({
      atKm: cum[i] / 1000,
      turn: classify(delta),
      lngLat: [coordinates[i][0], coordinates[i][1]],
    });
    lastCueDist = cum[i];
  }
  return cues;
}

function indexBefore(cum: number[], i: number): number {
  let j = i;
  while (j > 0 && cum[i] - cum[j] < BASELINE_M) j--;
  return j;
}

function indexAfter(cum: number[], i: number): number {
  let j = i;
  while (j < cum.length - 1 && cum[j] - cum[i] < BASELINE_M) j++;
  return j;
}

function bearingDeg(a: [number, number, number], b: [number, number, number]): number {
  const x = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  const y = b[1] - a[1];
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Signed turn angle in degrees: negative = left, positive = right. */
function signedTurnDeg(fromBearing: number, toBearing: number): number {
  let diff = toBearing - fromBearing;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

function classify(delta: number): TurnKind {
  const magnitude = Math.abs(delta);
  const dir = delta < 0 ? 'left' : 'right';
  if (magnitude >= 100) return `sharp-${dir}` as TurnKind;
  if (magnitude >= 50) return dir as TurnKind;
  return `slight-${dir}` as TurnKind;
}

export const TURN_LABEL: Record<TurnKind, string> = {
  'sharp-left': 'Sharp left',
  left: 'Left',
  'slight-left': 'Slight left',
  'slight-right': 'Slight right',
  right: 'Right',
  'sharp-right': 'Sharp right',
};

export const TURN_ARROW: Record<TurnKind, string> = {
  'sharp-left': '↩',
  left: '⬅',
  'slight-left': '↖',
  'slight-right': '↗',
  right: '➡',
  'sharp-right': '↪',
};
