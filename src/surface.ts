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
