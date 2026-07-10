// Climb detection from the route's elevation profile.
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
  const total = distances[distances.length - 1];
  if (total < 2 * SAMPLE_M) return [];

  const profile = resampleProfile(coordinates, distances);
  smoothElevations(profile);

  const climbs: Climb[] = [];
  let start = 0;
  while (start < profile.length - 1) {
    // Skip until the profile starts rising.
    if (profile[start + 1].elevation <= profile[start].elevation) {
      start++;
      continue;
    }
    // Extend the climb, tolerating small dips: it ends when we have dropped
    // more than 8 m (or 20% of the gain) below the highest point so far.
    let peak = start;
    let end = start;
    for (let i = start + 1; i < profile.length; i++) {
      if (profile[i].elevation >= profile[peak].elevation) {
        peak = i;
        end = i;
      } else {
        const gain = profile[peak].elevation - profile[start].elevation;
        const drop = profile[peak].elevation - profile[i].elevation;
        if (drop > Math.max(8, gain * 0.2)) break;
      }
      end = Math.max(end, peak);
    }

    const climb = buildClimb(profile, start, peak);
    if (climb) climbs.push(climb);
    start = Math.max(end, start + 1);
  }
  return climbs;
}

function buildClimb(profile: ProfileSample[], start: number, peak: number): Climb | null {
  const lengthM = profile[peak].distM - profile[start].distM;
  const gainM = profile[peak].elevation - profile[start].elevation;
  if (lengthM < MIN_LENGTH || gainM < MIN_GAIN) return null;
  const avgPct = (gainM / lengthM) * 100;
  if (avgPct < MIN_AVG_GRADE) return null;

  // Steepest 100 m stretch inside the climb.
  let maxPct = 0;
  const window = Math.max(1, Math.round(100 / SAMPLE_M));
  for (let i = start; i + window <= peak; i++) {
    const rise = profile[i + window].elevation - profile[i].elevation;
    const run = profile[i + window].distM - profile[i].distM;
    if (run > 0) maxPct = Math.max(maxPct, (rise / run) * 100);
  }

  return {
    startIndex: profile[start].coordIndex,
    endIndex: profile[peak].coordIndex,
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
