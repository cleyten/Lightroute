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
