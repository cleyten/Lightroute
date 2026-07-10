// Climb detection from the route's elevation profile.
// A climb is a sustained stretch where the road actually points up: samples
// whose gradient (over a 100 m window) exceeds a threshold, merged across
// short flats or dips. Growing "until the highest point" does not work: a
// climb followed by a long rolling plateau would swallow the plateau and
// dilute its own average grade.
// Thresholds are tuned for the Low Countries: a 15 m rise at 2% already
// counts, so the feature is useful outside the mountains too.

import { cumulativeDistances } from './geo';

export interface Climb {
  /** Index range into the ORIGINAL coordinates array. */
  startIndex: number;
  endIndex: number;
  startKm: number;
  lengthM: number;
  gainM: number;
  avgPct: number;
  maxPct: number;
}

const SAMPLE_M = 10; // profile resolution after resampling
const SMOOTH_M = 60; // moving-average window for elevation noise
const GRADE_WINDOW_M = 100; // window for the per-sample gradient
const CLIMBING_PCT = 1.5; // a sample is "climbing" above this gradient
const MERGE_GAP_M = 400; // bridge flats/dips shorter than this inside a climb
const MERGE_MAX_DROP = 10; // ...but never bridge a real descent (meters)
const MIN_GAIN = 15; // meters
const MIN_LENGTH = 250; // meters
const MIN_AVG_GRADE = 1.8; // percent

interface ProfileSample {
  distM: number;
  elevation: number;
  coordIndex: number;
}

export function detectClimbs(coordinates: [number, number, number][]): Climb[] {
  if (coordinates.length < 3) return [];
  const distances = cumulativeDistances(coordinates);
  if (distances[distances.length - 1] < 2 * GRADE_WINDOW_M) return [];

  const profile = resampleProfile(coordinates, distances);
  smoothElevations(profile);

  // Runs of consecutive "climbing" samples, as [startIdx, endIdx] pairs.
  const half = Math.max(1, Math.round(GRADE_WINDOW_M / SAMPLE_M / 2));
  const runs: [number, number][] = [];
  let runStart = -1;
  for (let i = 0; i < profile.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(profile.length - 1, i + half);
    const grade =
      ((profile[hi].elevation - profile[lo].elevation) /
        (profile[hi].distM - profile[lo].distM)) *
      100;
    if (grade >= CLIMBING_PCT) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push([runStart, profile.length - 1]);

  // Merge runs separated by a short gap, unless the gap really descends.
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (
      last &&
      profile[run[0]].distM - profile[last[1]].distM <= MERGE_GAP_M &&
      profile[last[1]].elevation - profile[run[0]].elevation <= MERGE_MAX_DROP
    ) {
      last[1] = run[1];
    } else {
      merged.push([...run]);
    }
  }

  const climbs: Climb[] = [];
  for (const [from, to] of merged) {
    const climb = buildClimb(profile, from, to);
    if (climb) climbs.push(climb);
  }
  return climbs;
}

function buildClimb(profile: ProfileSample[], start: number, end: number): Climb | null {
  const lengthM = profile[end].distM - profile[start].distM;
  const gainM = profile[end].elevation - profile[start].elevation;
  if (lengthM < MIN_LENGTH || gainM < MIN_GAIN) return null;
  const avgPct = (gainM / lengthM) * 100;
  if (avgPct < MIN_AVG_GRADE) return null;

  // Steepest 100 m stretch inside the climb.
  let maxPct = 0;
  const window = Math.max(1, Math.round(100 / SAMPLE_M));
  for (let i = start; i + window <= end; i++) {
    const rise = profile[i + window].elevation - profile[i].elevation;
    const run = profile[i + window].distM - profile[i].distM;
    if (run > 0) maxPct = Math.max(maxPct, (rise / run) * 100);
  }

  return {
    startIndex: profile[start].coordIndex,
    endIndex: profile[end].coordIndex,
    startKm: profile[start].distM / 1000,
    lengthM,
    gainM,
    avgPct,
    maxPct: Math.max(maxPct, avgPct),
  };
}

/** Resamples the track to fixed spacing, remembering source coordinate indices. */
function resampleProfile(
  coordinates: [number, number, number][],
  distances: number[],
): ProfileSample[] {
  const total = distances[distances.length - 1];
  const samples: ProfileSample[] = [];
  let seg = 1;
  for (let d = 0; d <= total; d += SAMPLE_M) {
    while (seg < distances.length - 1 && distances[seg] < d) seg++;
    const d0 = distances[seg - 1];
    const d1 = distances[seg];
    const t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    const e0 = coordinates[seg - 1][2] ?? 0;
    const e1 = coordinates[seg][2] ?? 0;
    samples.push({
      distM: d,
      elevation: e0 + (e1 - e0) * t,
      coordIndex: t < 0.5 ? seg - 1 : seg,
    });
  }
  return samples;
}

function smoothElevations(profile: ProfileSample[]): void {
  const radius = Math.round(SMOOTH_M / SAMPLE_M / 2);
  const raw = profile.map((p) => p.elevation);
  for (let i = 0; i < profile.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(profile.length - 1, i + radius); j++) {
      sum += raw[j];
      n++;
    }
    profile[i].elevation = sum / n;
  }
}
