// Client-side TCX (Garmin Training Center XML) export. Unlike a plain GPX
// track, a TCX Course can carry CoursePoint turn markers that Garmin Edge,
// Wahoo ELEMNT and Hammerhead Karoo read directly for turn-by-turn cues,
// instead of relying on the device's own map-matching of a bare track.
import { cumulativeDistances, bearingDegrees } from './geo';
import { escapeXml } from './gpx';

export interface TurnCue {
  distanceMeters: number;
  lngLat: [number, number];
  direction: 'Left' | 'Right';
}

// How far before/after a point to look when measuring the bearing change
// through it; below this angle it's not considered a real turn; turns closer
// together than this are merged (keeping the sharpest one).
const TURN_BASELINE_M = 70;
const TURN_MIN_DEG = 25;
const TURN_MIN_GAP_M = 120;

// Synthetic pacing only, so Trackpoint/CoursePoint times are monotonically
// increasing and roughly plausible. Devices navigate a course by position,
// not by these timestamps, so the exact speed assumed doesn't matter.
const ASSUMED_SPEED_MPS = 20000 / 3600; // 20 km/h

function normalizeAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Detects turns from the bearing change over a lookback/lookahead window
 * around each point, for embedding as TCX CoursePoints.
 */
export function detectTurns(coordinates: [number, number, number][]): TurnCue[] {
  if (coordinates.length < 3) return [];
  const cumulative = cumulativeDistances(coordinates);
  const total = cumulative[cumulative.length - 1];
  const candidates: (TurnCue & { angleDeg: number })[] = [];

  for (let i = 1; i < coordinates.length - 1; i++) {
    const target = cumulative[i];
    if (target < TURN_BASELINE_M || total - target < TURN_BASELINE_M) continue;

    let j = i;
    while (j > 0 && target - cumulative[j - 1] < TURN_BASELINE_M) j--;
    let k = i;
    while (k < coordinates.length - 1 && cumulative[k + 1] - target < TURN_BASELINE_M) k++;
    if (j === i || k === i) continue;

    const bearingIn = bearingDegrees(coordinates[j], coordinates[i]);
    const bearingOut = bearingDegrees(coordinates[i], coordinates[k]);
    const delta = normalizeAngle(bearingOut - bearingIn);
    if (Math.abs(delta) < TURN_MIN_DEG) continue;

    candidates.push({
      distanceMeters: target,
      lngLat: [coordinates[i][0], coordinates[i][1]],
      direction: delta > 0 ? 'Right' : 'Left',
      angleDeg: Math.abs(delta),
    });
  }

  const merged: (TurnCue & { angleDeg: number })[] = [];
  for (const candidate of candidates) {
    const prev = merged[merged.length - 1];
    if (prev && candidate.distanceMeters - prev.distanceMeters < TURN_MIN_GAP_M) {
      if (candidate.angleDeg > prev.angleDeg) merged[merged.length - 1] = candidate;
      continue;
    }
    merged.push(candidate);
  }

  return merged.map(({ distanceMeters, lngLat, direction }) => ({ distanceMeters, lngLat, direction }));
}

export function buildTcx(coordinates: [number, number, number][], name: string): string {
  const cumulative = cumulativeDistances(coordinates);
  const turns = detectTurns(coordinates);
  const startTime = new Date();
  const timeAt = (distanceMeters: number) =>
    new Date(startTime.getTime() + (distanceMeters / ASSUMED_SPEED_MPS) * 1000).toISOString();

  const trackpoints = coordinates
    .map(
      ([lng, lat, ele], i) => `      <Trackpoint>
        <Time>${timeAt(cumulative[i])}</Time>
        <Position>
          <LatitudeDegrees>${lat}</LatitudeDegrees>
          <LongitudeDegrees>${lng}</LongitudeDegrees>
        </Position>
        <AltitudeMeters>${ele ?? 0}</AltitudeMeters>
        <DistanceMeters>${cumulative[i].toFixed(1)}</DistanceMeters>
      </Trackpoint>`,
    )
    .join('\n');

  const coursePoints = turns
    .map(
      (turn) => `      <CoursePoint>
        <Name>${escapeXml(turn.direction)}</Name>
        <Time>${timeAt(turn.distanceMeters)}</Time>
        <Position>
          <LatitudeDegrees>${turn.lngLat[1]}</LatitudeDegrees>
          <LongitudeDegrees>${turn.lngLat[0]}</LongitudeDegrees>
        </Position>
        <PointType>${turn.direction}</PointType>
        <Notes>Turn ${turn.direction.toLowerCase()}</Notes>
      </CoursePoint>`,
    )
    .join('\n');

  const total = cumulative[cumulative.length - 1];
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Courses>
    <Course>
      <Name>${escapeXml(name)}</Name>
      <Lap>
        <TotalTimeSeconds>${Math.round(total / ASSUMED_SPEED_MPS)}</TotalTimeSeconds>
        <DistanceMeters>${total.toFixed(1)}</DistanceMeters>
        <BeginPosition>
          <LatitudeDegrees>${start[1]}</LatitudeDegrees>
          <LongitudeDegrees>${start[0]}</LongitudeDegrees>
        </BeginPosition>
        <EndPosition>
          <LatitudeDegrees>${end[1]}</LatitudeDegrees>
          <LongitudeDegrees>${end[0]}</LongitudeDegrees>
        </EndPosition>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${trackpoints}
      </Track>
${coursePoints}
    </Course>
  </Courses>
</TrainingCenterDatabase>
`;
}

export function downloadTcx(coordinates: [number, number, number][], name: string): void {
  const tcx = buildTcx(coordinates, name);
  const blob = new Blob([tcx], { type: 'application/vnd.garmin.tcx+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^\w-]+/g, '_')}.tcx`;
  link.click();
  URL.revokeObjectURL(url);
}
