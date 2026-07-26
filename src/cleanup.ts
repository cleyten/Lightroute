// Geometry post-processing for generated round trips.
// ORS loops regularly contain two artifacts that no routing parameter
// prevents: a short excursion into a side road that immediately backtracks
// (a dead-end spur, ridden only to pad the distance), and a small curl
// where the route crosses itself. Both are far too small to fail the
// route-wide quality gates (a 300 m spur is ~0.5% of a 60 km loop), so
// instead of rejecting the candidate they are spliced out of the geometry.

import { projectToMeters } from './loops';
import { fetchRoute, type RouteResult } from './routing';

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

// --- Detour wiggles ---------------------------------------------------------
// The third artifact: the route dives into a residential block and zigzags
// through it purely to pad distance, leaving from and returning to nearly
// the same spot without ever backtracking or self-crossing, so neither the
// spur nor the curl pass catches it. Detection: a sub-path much longer than
// the distance between its endpoints. Repair: re-route the two endpoints
// through BRouter with the bike's own profile; the replacement is only
// accepted when it is substantially shorter, which by definition means a
// real through-road exists. When no shortcut exists (an honestly winding
// road), the geometry is left alone.

/** Max length of a wiggle sub-path (meters). */
const WIGGLE_MAX_M = 2500;
const WIGGLE_MIN_M = 350;
/** Endpoints must be this close for the sub-path to count as a detour. */
const WIGGLE_ENDPOINT_M = 400;
/** Path length over endpoint distance must exceed this. */
const WIGGLE_RATIO = 2.8;
/** A heal must save at least this many meters (and be relatively shorter). */
const HEAL_MIN_SAVING_M = 300;
const HEAL_MAX_SHARE = 0.9;
/** Max wiggles healed per candidate. */
const MAX_HEALS = 3;
/** Point offsets to widen the excision window per attempt: the wiggle's own
 *  endpoints often sit inside the neighborhood; a wider window puts them on
 *  the through-road before and after it. */
const HEAL_OFFSETS = [0, 12];

export interface Wiggle {
  i: number;
  j: number;
  pathLen: number;
  directLen: number;
}

/** Finds non-overlapping detour wiggles, in route order. */
export function findWiggles(coords: Coord[]): Wiggle[] {
  const pts = projectToMeters(coords) as [number, number][];
  const cum = planarCumulative(pts);
  const out: Wiggle[] = [];
  let i = 1;
  while (i < pts.length - 5) {
    let best: Wiggle | null = null;
    for (let j = i + 5; j < pts.length - 1 && cum[j] - cum[i] <= WIGGLE_MAX_M; j++) {
      const pathLen = cum[j] - cum[i];
      if (pathLen < WIGGLE_MIN_M) continue;
      const directLen = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
      if (directLen < WIGGLE_ENDPOINT_M && pathLen / Math.max(directLen, 50) > WIGGLE_RATIO) {
        best = { i, j, pathLen, directLen };
      }
    }
    if (best) {
      out.push(best);
      i = best.j;
    } else {
      i++;
    }
  }
  return out;
}

export interface HealResult {
  coords: Coord[];
  segCodes: (number | null)[] | null;
  healedMeters: number;
}

/**
 * Ceiling on simultaneous heal requests across all candidates.
 *
 * Round-trip generation evaluates 8 candidates at once, so healing each one's
 * wiggles in parallel would put ~24 requests on the public BRouter server
 * concurrently. That invites rate limiting, which is slower than the
 * sequential version it replaced. This keeps the win without the flood.
 */
const HEAL_CONCURRENCY = 6;

let activeHeals = 0;
const healQueue: (() => void)[] = [];

async function withHealSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeHeals >= HEAL_CONCURRENCY) {
    await new Promise<void>((resolve) => healQueue.push(resolve));
  }
  activeHeals++;
  try {
    return await work();
  } finally {
    activeHeals--;
    healQueue.shift()?.();
  }
}

/** An accepted shortcut, resolved before any splicing happens. */
interface HealPlan {
  i: number;
  j: number;
  shortcut: Coord[];
  saving: number;
}

/**
 * Replaces detour wiggles with a direct re-route between their endpoints.
 *
 * Two phases. First every wiggle's shortcut is looked up concurrently; the
 * wiggles found by findWiggles are non-overlapping, and their endpoints are
 * read from the untouched `coords`, so these lookups do not depend on each
 * other. Then the accepted shortcuts are spliced in back-to-front, which keeps
 * lower indices valid as the array shrinks.
 *
 * The two HEAL_OFFSETS stay sequential within a wiggle: the wider window is a
 * fallback only tried when the tight one finds no through-road, so requesting
 * both up front would double the traffic for nothing.
 *
 * Surface codes for spliced stretches are unknown (filled with null).
 */
export async function healWiggles(
  coords: Coord[],
  segCodes: (number | null)[] | null,
  brouterProfile: string,
): Promise<HealResult> {
  const wiggles = findWiggles(coords)
    .sort((a, b) => b.pathLen - a.pathLen)
    .slice(0, MAX_HEALS)
    .sort((a, b) => b.i - a.i);

  const pts = projectToMeters(coords) as [number, number][];
  const cum = planarCumulative(pts);
  const maxIndex = coords.length - 2;

  const plans = await Promise.all(
    wiggles.map(async (w): Promise<HealPlan | null> => {
      for (const offset of HEAL_OFFSETS) {
        const i = Math.max(1, w.i - offset);
        const j = Math.min(maxIndex, w.j + offset);
        const excisedM = cum[j] - cum[i];

        let shortcut: RouteResult;
        try {
          shortcut = await withHealSlot(() =>
            fetchRoute(
              [
                [coords[i][0], coords[i][1]],
                [coords[j][0], coords[j][1]],
              ],
              brouterProfile,
            ),
          );
        } catch {
          return null; // BRouter unavailable; keep the original geometry.
        }
        if (shortcut.coordinates.length < 2) continue;
        const saving = excisedM - shortcut.distanceMeters;
        if (saving < HEAL_MIN_SAVING_M || shortcut.distanceMeters > excisedM * HEAL_MAX_SHARE) {
          continue; // no meaningfully shorter through-road via this window
        }
        return { i, j, shortcut: shortcut.coordinates, saving };
      }
      return null;
    }),
  );

  let outCoords = coords;
  let outCodes = segCodes;
  let healed = 0;
  // Indices at or below `limit` still refer to the same points in the spliced
  // array as in the original. Widening by HEAL_OFFSETS can make two plans
  // overlap even though their wiggles did not; the later one is then dropped.
  let limit = maxIndex;

  for (const plan of plans) {
    if (!plan || plan.j >= limit) continue;
    const { i, j, shortcut } = plan;
    outCoords = outCoords.slice(0, i).concat(shortcut, outCoords.slice(j + 1));
    if (outCodes) {
      outCodes = outCodes
        .slice(0, i - 1)
        .concat(new Array(shortcut.length + 1).fill(null), outCodes.slice(j + 1));
    }
    healed += plan.saving;
    limit = i - 1;
  }
  return { coords: outCoords, segCodes: outCodes, healedMeters: healed };
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
