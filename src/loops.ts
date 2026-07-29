// Loop quality analysis: geometry scoring for generated round trips.
// Everything works on a local equirectangular projection in meters, which is
// accurate enough at loop scale (< ~100 km).

type Coord = [number, number] | [number, number, number];

const EARTH_RADIUS_M = 6371000;

/** Projects [lng, lat] coordinates to local meters around the first point. */
export function projectToMeters(coords: Coord[]): [number, number][] {
  const lat0 = (coords[0][1] * Math.PI) / 180;
  const kx = EARTH_RADIUS_M * Math.cos(lat0) * (Math.PI / 180);
  const ky = EARTH_RADIUS_M * (Math.PI / 180);
  return coords.map(([lng, lat]) => [lng * kx, lat * ky]);
}

/** Resamples a projected line to (roughly) equidistant points. */
export function resample(points: [number, number][], spacingM: number): [number, number][] {
  if (points.length < 2) return points.slice();
  const out: [number, number][] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    let [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    let segment = Math.hypot(cx - px, cy - py);
    while (carry + segment >= spacingM) {
      const t = (spacingM - carry) / segment;
      const nx = px + (cx - px) * t;
      const ny = py + (cy - py) * t;
      out.push([nx, ny]);
      segment -= spacingM - carry;
      carry = 0;
      px = nx;
      py = ny;
    }
    carry += segment;
  }
  return out;
}

/**
 * Fraction of the route ridden over ground that was already ridden (0..1).
 * A perfect loop scores near 0; a full out-and-back scores near 0.5. This is
 * what catches ORS's "ride into a side street and back out" filler: those
 * meters are all repeats. Computed by snapping the resampled track to a grid
 * and counting undirected grid-edge traversals beyond the first.
 */
export function overlapRatio(coords: Coord[]): number {
  const CELL = 18; // meters; same road in both directions lands in one cell
  const samples = resample(projectToMeters(coords), 12);
  if (samples.length < 4) return 0;

  const cells: string[] = [];
  for (const [x, y] of samples) {
    const key = `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
    if (cells[cells.length - 1] !== key) cells.push(key);
  }

  const seen = new Map<string, number>();
  let repeats = 0;
  let total = 0;
  for (let i = 1; i < cells.length; i++) {
    const edge = cells[i - 1] < cells[i] ? `${cells[i - 1]}|${cells[i]}` : `${cells[i]}|${cells[i - 1]}`;
    const count = (seen.get(edge) ?? 0) + 1;
    seen.set(edge, count);
    total++;
    if (count > 1) repeats++;
  }
  return total > 0 ? repeats / total : 0;
}

export interface BacktrackReport {
  /** Total distance ridden alongside ground the route already covers. */
  totalMeters: number;
  /** Longest single such stretch; one bad U-turn shows up here, not in the total. */
  longestMeters: number;
}

/** Sample spacing for the corridor scan (meters). */
const BACKTRACK_SAMPLE_M = 15;
/** Two passes this close together count as the same ground. */
const BACKTRACK_CORRIDOR_M = 32;
/**
 * Passes must be at least this far apart along the route to count. Below it,
 * the route is simply continuing (and a genuine hairpin bend stays legal).
 *
 * This directly sets the shortest U-turn the measure can see: an excursion of L
 * meters out and L back only registers 2(L - separation/2) meters, so at 150 a
 * U-turn under about 75 m each way is invisible. That is deliberate. Going any
 * lower starts reading tight switchbacks and dual-carriageway junctions as
 * doubling back, and excursions that short are handled by splicing them out in
 * cleanup.ts rather than by rejecting the whole loop.
 */
const BACKTRACK_SEPARATION_M = 150;
/** Ignore stretches shorter than this: a plain crossing is not a backtrack. */
const BACKTRACK_MIN_RUN_M = 75;
/** Unflagged samples tolerated inside one run (a bridge, a wide junction). */
const BACKTRACK_RUN_GAP = 2;

/**
 * Measures how much of the route rides back alongside ground it already
 * covers, which is the thing riders actually object to: a U-turn at a
 * roundabout, an out-and-back on a side road, a leg out over the main road
 * and back over the cycleway beside it.
 *
 * Deliberately not the same test as overlapRatio. That one snaps to an 18 m
 * grid and so only sees an exact retrace of the same polyline; a return leg on
 * the parallel carriageway lands in different cells and scores zero. This walks
 * a corridor instead, so anything within a road's width counts, and it reports
 * meters rather than a share, because a 300 m U-turn is just as unacceptable in
 * a 60 km loop as in a 20 km one.
 */
export function backtrackReport(coords: Coord[]): BacktrackReport {
  const points = projectToMeters(coords);
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]),
    );
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (total < BACKTRACK_SEPARATION_M * 2) return { totalMeters: 0, longestMeters: 0 };

  // Resample at a fixed spacing, keeping each sample's distance along the
  // route: that is what separates "the route is still going" from "the route
  // came back here".
  const samples: { x: number; y: number; along: number }[] = [];
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const span = cumulative[i] - cumulative[i - 1];
    while (along <= cumulative[i]) {
      const t = span > 0 ? (along - cumulative[i - 1]) / span : 0;
      samples.push({
        x: points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
        y: points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
        along,
      });
      along += BACKTRACK_SAMPLE_M;
    }
  }

  const grid = new Map<string, number[]>();
  samples.forEach((sample, index) => {
    const key = `${Math.round(sample.x / BACKTRACK_CORRIDOR_M)},${Math.round(sample.y / BACKTRACK_CORRIDOR_M)}`;
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(index);
  });

  const flagged = samples.map((sample) => {
    const cx = Math.round(sample.x / BACKTRACK_CORRIDOR_M);
    const cy = Math.round(sample.y / BACKTRACK_CORRIDOR_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const gap = Math.abs(samples[other].along - sample.along);
          // A loop legitimately ends where it began, so distance measured the
          // short way round the loop is what matters.
          if (Math.min(gap, total - gap) < BACKTRACK_SEPARATION_M) continue;
          if (
            Math.hypot(samples[other].x - sample.x, samples[other].y - sample.y) <=
            BACKTRACK_CORRIDOR_M
          ) {
            return true;
          }
        }
      }
    }
    return false;
  });

  let totalMeters = 0;
  let longestMeters = 0;
  let runStart = -1;
  let missing = 0;
  const closeRun = (end: number): void => {
    if (runStart < 0) return;
    const meters = (end - runStart + 1) * BACKTRACK_SAMPLE_M;
    if (meters >= BACKTRACK_MIN_RUN_M) {
      totalMeters += meters;
      longestMeters = Math.max(longestMeters, meters);
    }
    runStart = -1;
  };
  let lastFlagged = -1;
  for (let i = 0; i < flagged.length; i++) {
    if (flagged[i]) {
      if (runStart < 0) runStart = i;
      lastFlagged = i;
      missing = 0;
    } else if (runStart >= 0 && ++missing > BACKTRACK_RUN_GAP) {
      closeRun(lastFlagged);
      missing = 0;
    }
  }
  closeRun(lastFlagged);
  return { totalMeters, longestMeters };
}

/**
 * Isoperimetric quotient (4·pi·area / perimeter²): 1 for a perfect circle,
 * near 0 for out-and-back shapes or loops with filler curls.
 */
export function loopRoundness(coords: Coord[], perimeterM: number): number {
  if (coords.length < 3 || perimeterM === 0) return 0;
  const points = projectToMeters(coords);
  let doubleArea = 0;
  for (let i = 1; i < points.length; i++) {
    doubleArea += points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1];
  }
  const area = Math.abs(doubleArea) / 2;
  return (4 * Math.PI * area) / perimeterM ** 2;
}

/**
 * Mean travel bearing (degrees, 0 = north) over the first part of the route.
 * Used to prefer loops that head into the wind first.
 */
export function initialBearing(coords: Coord[], fraction = 0.45): number {
  const points = resample(projectToMeters(coords), 50);
  const end = Math.max(2, Math.floor(points.length * fraction));
  let vx = 0;
  let vy = 0;
  for (let i = 1; i < end; i++) {
    vx += points[i][0] - points[i - 1][0];
    vy += points[i][1] - points[i - 1][1];
  }
  return ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
}

/** Undirected grid-edge set of a route, for comparing candidates. */
export function edgeSet(coords: Coord[]): Set<string> {
  const CELL = 30;
  const samples = resample(projectToMeters(coords), 20);
  const cells: string[] = [];
  for (const [x, y] of samples) {
    const key = `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
    if (cells[cells.length - 1] !== key) cells.push(key);
  }
  const edges = new Set<string>();
  for (let i = 1; i < cells.length; i++) {
    edges.add(cells[i - 1] < cells[i] ? `${cells[i - 1]}|${cells[i]}` : `${cells[i]}|${cells[i - 1]}`);
  }
  return edges;
}

/** Jaccard similarity of two routes' edge sets (0..1). */
export function routeSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const edge of small) {
    if (large.has(edge)) shared++;
  }
  return shared / (a.size + b.size - shared);
}
