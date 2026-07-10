// Surface-type breakdown parsed from BRouter's "messages" data.
// Each message row describes a route segment and includes the distance and
// the OSM way tags (e.g. "highway=residential surface=asphalt") of that segment.

export interface SurfaceTotals {
  paved: number;
  cobbles: number;
  unpaved: number;
  unknown: number;
  totalMeters: number;
}

const PAVED = new Set([
  'asphalt',
  'paved',
  'concrete',
  'concrete:plates',
  'concrete:lanes',
  'metal',
  'wood',
]);

const COBBLES = new Set([
  'paving_stones',
  'sett',
  'cobblestone',
  'unhewn_cobblestone',
  'bricks',
  'grass_paver',
]);

const UNPAVED = new Set([
  'gravel',
  'fine_gravel',
  'compacted',
  'unpaved',
  'ground',
  'dirt',
  'earth',
  'mud',
  'sand',
  'grass',
  'woodchips',
  'pebblestone',
  'rock',
]);

// ORS surface codes (extra_info "surface") mapped to our categories.
// See openrouteservice docs, "Extra info: surface".
const ORS_PAVED = new Set([1, 3, 4, 6, 7]); // Paved, Asphalt, Concrete, Metal, Wood
const ORS_COBBLES = new Set([5, 14, 18]); // Cobblestone, Paving Stones, Grass Paver
const ORS_UNPAVED = new Set([2, 8, 9, 10, 11, 12, 13, 15, 16, 17]);

export interface OrsSurfaceExtra {
  /** Rows of [fromCoordIndex, toCoordIndex, surfaceCode]. */
  values: [number, number, number][];
}

/**
 * Expands ORS extra rows ([fromCoord, toCoord, code]) into one surface code
 * per route segment (coordinate i to i+1), so the codes can be spliced in
 * step with the geometry during cleanup.
 */
export function extrasToSegmentCodes(
  extra: OrsSurfaceExtra | undefined,
  coordCount: number,
): (number | null)[] | null {
  if (!extra?.values?.length || coordCount < 2) return null;
  const codes: (number | null)[] = new Array(coordCount - 1).fill(null);
  for (const [from, to, code] of extra.values) {
    for (let i = Math.max(0, from); i < Math.min(to, codes.length); i++) {
      codes[i] = code;
    }
  }
  return codes;
}

/**
 * Surface totals from per-segment codes. `cumulative` is the running
 * distance per coordinate, so segment i covers
 * cumulative[i+1] - cumulative[i] meters.
 */
export function surfaceFromSegmentCodes(
  codes: (number | null)[] | null,
  cumulative: number[],
): SurfaceTotals | null {
  if (!codes?.length) return null;
  const totals: SurfaceTotals = { paved: 0, cobbles: 0, unpaved: 0, unknown: 0, totalMeters: 0 };
  for (let i = 0; i < codes.length && i + 1 < cumulative.length; i++) {
    const meters = cumulative[i + 1] - cumulative[i];
    if (meters <= 0) continue;
    totals.totalMeters += meters;
    const code = codes[i];
    if (code === null) totals.unknown += meters;
    else if (ORS_PAVED.has(code)) totals.paved += meters;
    else if (ORS_COBBLES.has(code)) totals.cobbles += meters;
    else if (ORS_UNPAVED.has(code)) totals.unpaved += meters;
    else totals.unknown += meters;
  }
  return totals.totalMeters > 0 ? totals : null;
}

/**
 * Unpaved share of the surface we know about (0..1), or null when too much
 * of the route has unknown surface for the number to mean anything.
 */
export function unpavedFraction(totals: SurfaceTotals | null): number | null {
  if (!totals) return null;
  const known = totals.totalMeters - totals.unknown;
  if (known < totals.totalMeters * 0.4) return null;
  return (totals.unpaved + totals.cobbles * 0.3) / known;
}

export function surfaceBreakdown(messages: string[][]): SurfaceTotals | null {
  if (messages.length < 2) return null;
  const header = messages[0];
  const distIdx = header.indexOf('Distance');
  const tagsIdx = header.indexOf('WayTags');
  if (distIdx < 0 || tagsIdx < 0) return null;

  const totals: SurfaceTotals = {
    paved: 0,
    cobbles: 0,
    unpaved: 0,
    unknown: 0,
    totalMeters: 0,
  };

  for (const row of messages.slice(1)) {
    const meters = Number(row[distIdx]) || 0;
    totals.totalMeters += meters;
    const surface = /(?:^|\s)surface=(\S+)/.exec(row[tagsIdx] ?? '')?.[1];
    if (!surface) totals.unknown += meters;
    else if (PAVED.has(surface)) totals.paved += meters;
    else if (COBBLES.has(surface)) totals.cobbles += meters;
    else if (UNPAVED.has(surface)) totals.unpaved += meters;
    else totals.unknown += meters;
  }
  return totals.totalMeters > 0 ? totals : null;
}

const LEGEND: { key: keyof Omit<SurfaceTotals, 'totalMeters'>; label: string; color: string }[] = [
  { key: 'paved', label: 'Paved', color: '#4a4a4a' },
  { key: 'cobbles', label: 'Cobbles', color: '#c9822b' },
  { key: 'unpaved', label: 'Unpaved', color: '#8a6f47' },
  { key: 'unknown', label: 'Unknown', color: '#c4c4c4' },
];

export function renderSurfaceBar(container: HTMLElement, totals: SurfaceTotals): void {
  container.innerHTML = '';

  const track = document.createElement('div');
  track.className = 'surface-track';
  const legend = document.createElement('div');
  legend.className = 'surface-legend';

  for (const { key, label, color } of LEGEND) {
    const pct = (totals[key] / totals.totalMeters) * 100;
    if (pct < 0.5) continue;

    const segment = document.createElement('div');
    segment.style.width = `${pct}%`;
    segment.style.background = color;
    segment.title = `${label}: ${pct.toFixed(0)}%`;
    track.append(segment);

    const item = document.createElement('span');
    item.innerHTML = `<i style="background:${color}"></i>${label} ${pct.toFixed(0)}%`;
    legend.append(item);
  }

  container.append(track, legend);
}
