// Geometry post-processing for generated round trips.
// ORS loops regularly contain two artifacts that no routing parameter
// prevents: a short excursion into a side road that immediately backtracks
// (a dead-end spur, ridden only to pad the distance), and a small curl
// where the route crosses itself. Both are far too small to fail the
// route-wide quality gates (a 300 m spur is ~0.5% of a 60 km loop), so
// instead of rejecting the candidate they are spliced out of the geometry.

import { projectToMeters } from './loops';

/** Max length of an out-and-back excursion that gets removed (meters). */
const SPUR_MAX_M = 2200;
/** The spur's entry and exit points must be this close together. */
const SPUR_JUNCTION_M = 35;
/** Outbound and return paths of a spur must stay within this distance. */
const SPUR_MATCH_M = 65;
/** Max circumference of a self-intersection curl that gets removed. */
const CURL_MAX_M = 2600;
/** ...and it must also be a small fraction of the whole route. */
const CURL_MAX_FRACTION = 0.12;
const CELL = 25; // meters, spatial hash for candidate lookup

type Coord = [number, number, number];

export interface CleanResult {
  coords: Coord[];
  /** Per-segment surface codes, spliced in step with the coordinates. */
  segCodes: (number | null)[] | null;
  removedMeters: number;
}

export function cleanLoopGeometry(
  coords: Coord[],
  segCodes: (number | null)[] | null,
): CleanResult {
  let current = coords;
  let codes = segCodes;
  let removed = 0;

  // Each pass removes at most one artifact; repeat until stable.
  for (let pass = 0; pass < 12; pass++) {
    const spur = removeOneSpur(current, codes);
    if (spur) {
      removed += spur.removedMeters;
      current = spur.coords;
      codes = spur.segCodes;
      continue;
    }
    const curl = removeOneCurl(current, codes);
    if (curl) {
      removed += curl.removedMeters;
      current = curl.coords;
      codes = curl.segCodes;
      continue;
    }
    break;
  }
  return { coords: current, segCodes: codes, removedMeters: removed };
}

/** Planar cumulative distances over projected points. */
function planarCumulative(pts: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return out;
}

function cellKey(x: number, y: number): string {
  return `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
}

/**
 * Finds one dead-end spur: indices i < j whose points (nearly) coincide,
 * with a short path between them that runs out and back over itself
 * (position i+m matches position j-m for all m). Removes everything
 * strictly between i and j.
 */
function removeOneSpur(
  coords: Coord[],
  segCodes: (number | null)[] | null,
): CleanResult | null {
  const pts = projectToMeters(coords) as [number, number][];
  const cum = planarCumulative(pts);
  const total = cum[cum.length - 1];

  const byCell = new Map<string, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const key = cellKey(pts[i][0], pts[i][1]);
    let list = byCell.get(key);
    if (!list) byCell.set(key, (list = []));
    list.push(i);
  }

  for (const indices of byCell.values()) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length - 1; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a];
        const j = indices[b];
        if (j - i < 6) continue;
        const pathLen = cum[j] - cum[i];
        if (pathLen > SPUR_MAX_M || pathLen > total - 500) continue;
        if (Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) > SPUR_JUNCTION_M) continue;
        if (!isPalindromic(pts, i, j)) continue;

        const coordsOut = coords.slice(0, i + 1).concat(coords.slice(j));
        let codesOut: (number | null)[] | null = null;
        if (segCodes) {
          // Segment i now bridges i -> j (near-zero length); give it the
          // code of the spur's entry segment.
          codesOut = segCodes.slice(0, i).concat([segCodes[i]], segCodes.slice(j));
        }
        return { coords: coordsOut, segCodes: codesOut, removedMeters: pathLen };
      }
    }
  }
  return null;
}

/** True when the path from i to j retraces itself (out-and-back). */
function isPalindromic(pts: [number, number][], i: number, j: number): boolean {
  const half = Math.floor((j - i) / 2);
  const checks = Math.min(8, half);
  for (let c = 1; c <= checks; c++) {
    const m = Math.round((half * c) / checks);
    const [ax, ay] = pts[i + m];
    const [bx, by] = pts[j - m];
    if (Math.hypot(ax - bx, ay - by) > SPUR_MATCH_M) return false;
  }
  return true;
}

/**
 * Finds one small curl and removes it. Two mechanisms:
 *
 * 1. Vertex proximity: the route returns to (nearly) the same point after a
 *    short stretch that encloses real area. This is the common case: a
 *    route crossing itself does so at a road junction, which is a shared
 *    polyline vertex, so a pure segment-intersection test misses it. The
 *    area requirement protects legitimate hairpin bends, which enclose
 *    only a thin sliver.
 * 2. Proper mid-segment crossing, replaced by the intersection point.
 */
function removeOneCurl(
  coords: Coord[],
  segCodes: (number | null)[] | null,
): CleanResult | null {
  const pts = projectToMeters(coords) as [number, number][];
  const cum = planarCumulative(pts);
  const total = cum[cum.length - 1];
  const maxCurl = Math.min(CURL_MAX_M, total * CURL_MAX_FRACTION);

  // Mechanism 1: near-coincident vertices enclosing a short cycle.
  const pointCells = new Map<string, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const key = cellKey(pts[i][0], pts[i][1]);
    let list = pointCells.get(key);
    if (!list) pointCells.set(key, (list = []));
    list.push(i);
  }
  for (const indices of pointCells.values()) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length - 1; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a];
        const j = indices[b];
        if (j - i < 4) continue;
        const cycleLen = cum[j] - cum[i];
        if (cycleLen < 100 || cycleLen > maxCurl) continue;
        if (Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) > CELL) continue;
        // Hairpins enclose a thin sliver; curls enclose real area.
        if (enclosedArea(pts, i, j) < Math.max(3000, cycleLen * 8)) continue;

        const coordsOut = coords.slice(0, i + 1).concat(coords.slice(j));
        let codesOut: (number | null)[] | null = null;
        if (segCodes) {
          codesOut = segCodes.slice(0, i).concat([segCodes[i]], segCodes.slice(j));
        }
        return { coords: coordsOut, segCodes: codesOut, removedMeters: cycleLen };
      }
    }
  }

  // Spatial hash of segments: each segment registers every cell it passes
  // through (sampled at sub-cell spacing so long segments miss nothing).
  const byCell = new Map<string, number[]>();
  const register = (key: string, seg: number) => {
    let list = byCell.get(key);
    if (!list) byCell.set(key, (list = []));
    if (list[list.length - 1] !== seg) list.push(seg);
  };
  for (let s = 0; s < pts.length - 1; s++) {
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[s + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (CELL / 2)));
    for (let k = 0; k <= steps; k++) {
      register(cellKey(x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps), s);
    }
  }

  for (const segments of byCell.values()) {
    if (segments.length < 2) continue;
    for (let a = 0; a < segments.length - 1; a++) {
      for (let b = a + 1; b < segments.length; b++) {
        const i = Math.min(segments[a], segments[b]);
        const j = Math.max(segments[a], segments[b]);
        if (j - i < 4) continue;

        const hit = segmentIntersection(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        if (!hit) continue;
        const posI = cum[i] + hit.t * (cum[i + 1] - cum[i]);
        const posJ = cum[j] + hit.u * (cum[j + 1] - cum[j]);
        const curlLen = posJ - posI;
        if (curlLen <= 0 || curlLen > maxCurl) continue;

        // Elevation at the crossing: borrow from the first segment's start.
        const point: Coord = [
          hit.x / metersPerLng(coords),
          hit.y / metersPerLat(),
          coords[i][2] ?? 0,
        ];
        const coordsOut = coords.slice(0, i + 1).concat([point], coords.slice(j + 1));
        let codesOut: (number | null)[] | null = null;
        if (segCodes) {
          codesOut = segCodes.slice(0, i).concat(
            [segCodes[i], segCodes[j]],
            segCodes.slice(j + 1),
          );
        }
        return { coords: coordsOut, segCodes: codesOut, removedMeters: curlLen };
      }
    }
  }
  return null;
}

/** Area (m²) enclosed by the sub-path i..j, closed back to i (shoelace). */
function enclosedArea(pts: [number, number][], i: number, j: number): number {
  let doubleArea = 0;
  for (let k = i; k < j; k++) {
    doubleArea += pts[k][0] * pts[k + 1][1] - pts[k + 1][0] * pts[k][1];
  }
  doubleArea += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(doubleArea) / 2;
}

// projectToMeters is anchored on the first coordinate's latitude; these
// factors must match it so intersection points can be unprojected.
let lat0Cache = 0;
function metersPerLng(coords: Coord[]): number {
  lat0Cache = (coords[0][1] * Math.PI) / 180;
  return 6371000 * Math.cos(lat0Cache) * (Math.PI / 180);
}
function metersPerLat(): number {
  return 6371000 * (Math.PI / 180);
}

interface Intersection {
  x: number;
  y: number;
  t: number; // position on segment a (0..1)
  u: number; // position on segment b (0..1)
}

/** Proper crossing of two segments (shared endpoints excluded). */
function segmentIntersection(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number],
): Intersection | null {
  const dax = a2[0] - a1[0];
  const day = a2[1] - a1[1];
  const dbx = b2[0] - b1[0];
  const dby = b2[1] - b1[1];
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-9) return null; // parallel

  const t = ((b1[0] - a1[0]) * dby - (b1[1] - a1[1]) * dbx) / denom;
  const u = ((b1[0] - a1[0]) * day - (b1[1] - a1[1]) * dax) / denom;
  const EPS = 1e-6;
  if (t < EPS || t > 1 - EPS || u < EPS || u > 1 - EPS) return null;
  return { x: a1[0] + t * dax, y: a1[1] + t * day, t, u };
}
