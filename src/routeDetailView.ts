// Route detail: a full-screen mobile view and a floating desktop panel,
// sharing the same data and small building blocks but showing different
// subsets of it (the panel has no header/hero/tabs/climbs list/stops — see
// HANDOFF-style note in the redesign plan: the mockup's desktop panel is a
// compact widget, not a second copy of the mobile screen).
//
// Like surface.ts/gradelegend.ts/preview.ts, these functions take the
// container and data as arguments rather than resolving their own DOM
// lookups, so main.ts (which owns dom.ts) stays the single place elements are
// found. Each render call returns the <canvas> it created (or null when there
// is no route) so the caller can hand it to chart.ts's lazy-loaded, real
// interactive elevation chart exactly as before.
import type { Climb } from './climbs';
import type { Cafe } from './cafes';
import type { WaterPoint } from './water';
import { renderSurfaceBar, unpavedFraction, type SurfaceTotals } from './surface';
import { gradeColor } from './gradelegend';
import { escapeHtml } from './ui';
import { state } from './state';

export interface RouteDetailData {
  title: string;
  distanceKm: number;
  ascendM: number;
  timeHours: number;
  closed: boolean;
  coordinates: [number, number, number][];
  climbs: Climb[];
  selectedClimb: number;
  surfaceTotals: SurfaceTotals | null;
  cafes: Cafe[];
  water: WaterPoint[];
}

export interface RouteDetailCallbacks {
  onBack: () => void;
  onShare: () => void;
  onSave: () => void;
  onExportGpx: () => void;
  onClimbClick: (climb: Climb, index: number) => void;
  onPoiClick: (lngLat: [number, number]) => void;
}

function formatTime(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A route-shape sketch for the detail hero: real geometry (not just
 * waypoints, unlike preview.ts's community-list icon), drawn white-halo-then-
 * blue like the route line on the live map, over a plain surface tint. There
 * is no real map tile background here on purpose (matches the rest of the
 * redesign, and avoids running a second live MapLibre instance just for one
 * small crop) — see the project brief: "map background is abstract, not real
 * tiles".
 */
function buildHeroSvg(coordinates: [number, number, number][], width: number, height: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'hero-shape');
  svg.setAttribute('aria-hidden', 'true');
  if (coordinates.length < 2) return svg;

  const pad = Math.min(width, height) * 0.12;
  const kx = Math.cos((coordinates[0][1] * Math.PI) / 180);
  const pts = coordinates.map(([lng, lat]) => [lng * kx, lat] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1e-6;
  const spanY = Math.max(...ys) - minY || 1e-6;
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const project = ([x, y]: [number, number]): [number, number] => [
    offX + (x - minX) * scale,
    height - (offY + (y - minY) * scale),
  ];

  const points = pts.map(project);
  const toAttr = (p: [number, number][]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const halo = document.createElementNS(SVG_NS, 'polyline');
  halo.setAttribute('points', toAttr(points));
  halo.setAttribute('fill', 'none');
  halo.setAttribute('stroke', 'var(--color-panel)');
  halo.setAttribute('stroke-width', '7');
  halo.setAttribute('stroke-linejoin', 'round');
  halo.setAttribute('stroke-linecap', 'round');
  svg.append(halo);

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', toAttr(points));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--color-accent)');
  line.setAttribute('stroke-width', '3.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(line);

  const [startX, startY] = points[0];
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(startX));
  dot.setAttribute('cy', String(startY));
  dot.setAttribute('r', '6');
  dot.setAttribute('fill', '#34a853');
  dot.setAttribute('stroke', 'var(--color-panel)');
  dot.setAttribute('stroke-width', '2.5');
  svg.append(dot);

  return svg;
}

const ICONS = {
  back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12a1 1 0 0 1 1 1v16l-7-4-7 4V5a1 1 0 0 1 1-1Z"/></svg>',
  exportIco: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 19h16"/></svg>',
  cafe: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#8a5a2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/></svg>',
  water: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#1f8fbf" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3s6 6.2 6 10.2A6 6 0 0 1 6 13.2C6 9.2 12 3 12 3z"/></svg>',
};

function statRow(entries: { label: string; value: string; unit: string }[]): string {
  return (
    `<div class="detail-stats">` +
    entries
      .map(
        ({ label, value, unit }) =>
          `<div class="detail-stat"><span class="detail-stat-label">${label}</span>` +
          `<span class="detail-stat-value">${value}<span class="unit">${unit}</span></span></div>`,
      )
      .join('') +
    `</div>`
  );
}

function climbsListHtml(climbs: Climb[], selected: number): string {
  if (climbs.length === 0) return `<p class="detail-empty">No notable climbs on this route.</p>`;
  return (
    `<ul class="detail-climbs">` +
    climbs
      .map(
        (climb, i) =>
          `<li><button type="button" class="climb-item${i === selected ? ' active' : ''}" data-climb-index="${i}">` +
          `<span class="climb-grade" style="background:${gradeColor(climb.avgPct)}">${climb.avgPct.toFixed(1)}%</span>` +
          `<span class="climb-info"><span class="climb-where">km ${climb.startKm.toFixed(1)}</span>` +
          `<span class="climb-len">${(climb.lengthM / 1000).toFixed(1)} km climb</span></span>` +
          `<span class="climb-gain">+${Math.round(climb.gainM)} m</span></button></li>`,
      )
      .join('') +
    `</ul>`
  );
}

function stopsListHtml(cafes: Cafe[], water: WaterPoint[]): string {
  const rows = [
    ...cafes.map((c) => ({ ...c, icon: ICONS.cafe, water: false })),
    ...water.map((w) => ({ ...w, icon: ICONS.water, water: true })),
  ].sort((a, b) => a.atKm - b.atKm);
  if (rows.length === 0) return `<p class="detail-empty">No cafés or water found along this route.</p>`;
  // Reuses the existing cafe-item/water-item row styling (icon prepended).
  return (
    `<ul class="detail-stops">` +
    rows
      .map(
        (stop, i) =>
          `<li><button type="button" class="cafe-item${stop.water ? ' water-item' : ''}" data-stop-index="${i}">` +
          `<span class="stop-ico">${stop.icon}</span>` +
          `<span class="cafe-where">km ${stop.atKm.toFixed(1)}</span>` +
          `<span class="cafe-name">${escapeHtml(stop.name)}</span>` +
          `<span class="${stop.water ? 'water-detour' : 'cafe-detour'}">${Math.round(stop.offRouteM)} m</span>` +
          `</button></li>`,
      )
      .join('') +
    `</ul>`
  );
}

/** Renders the full-screen mobile route detail. Returns the elevation chart's canvas. */
export function renderRouteDetailFullscreen(
  container: HTMLElement,
  data: RouteDetailData,
  callbacks: RouteDetailCallbacks,
): HTMLCanvasElement {
  const cafeCount = data.cafes.length;
  const waterCount = data.water.length;
  const tab = state.routeDetailTab;

  container.innerHTML =
    `<div class="detail-header">` +
    `<button type="button" class="icon-btn-bare" data-action="back">${ICONS.back}</button>` +
    `<span class="detail-title">${escapeHtml(data.title)}</span>` +
    `<button type="button" class="icon-btn-bare" data-action="share">${ICONS.share}</button>` +
    `</div>` +
    `<div class="detail-hero"></div>` +
    `<div class="detail-body">` +
    statRow([
      { label: 'Distance', value: data.distanceKm.toFixed(1), unit: 'km' },
      { label: 'Climbing', value: String(Math.round(data.ascendM)), unit: 'm' },
      { label: 'Time', value: formatTime(data.timeHours), unit: '' },
    ]) +
    `<div class="detail-chart-wrap"><canvas class="detail-chart"></canvas></div>` +
    `<div class="detail-tabs" role="tablist">` +
    (['climbs', 'surface', 'stops'] as const)
      .map(
        (name) =>
          `<button type="button" class="detail-tab${name === tab ? ' active' : ''}" data-tab="${name}" role="tab" aria-selected="${name === tab}">${
            name === 'climbs' ? 'Climbs' : name === 'surface' ? 'Surface' : 'Stops'
          }</button>`,
      )
      .join('') +
    `</div>` +
    `<div class="detail-tab-body">` +
    (tab === 'climbs'
      ? climbsListHtml(data.climbs, data.selectedClimb)
      : tab === 'surface'
        ? `<div class="detail-surface"></div>`
        : stopsListHtml(data.cafes, data.water)) +
    `</div>` +
    `</div>` +
    `<div class="detail-footer">` +
    `<button type="button" class="icon-btn detail-bookmark" data-action="save">${ICONS.bookmark}</button>` +
    `<button type="button" class="primary detail-export" data-action="export">${ICONS.exportIco}Export GPX</button>` +
    `</div>`;

  const hero = container.querySelector<HTMLElement>('.detail-hero')!;
  hero.append(buildHeroSvg(data.coordinates, 390, 168));
  const heroPills = document.createElement('div');
  heroPills.className = 'detail-hero-pills';
  if (cafeCount > 0) heroPills.innerHTML += `<span class="hero-pill">${ICONS.cafe}${cafeCount}</span>`;
  if (waterCount > 0) heroPills.innerHTML += `<span class="hero-pill">${ICONS.water}${waterCount}</span>`;
  hero.append(heroPills);

  if (tab === 'surface' && data.surfaceTotals) {
    renderSurfaceBar(container.querySelector<HTMLElement>('.detail-surface')!, data.surfaceTotals);
  }

  container.querySelector('[data-action="back"]')!.addEventListener('click', callbacks.onBack);
  container.querySelector('[data-action="share"]')!.addEventListener('click', callbacks.onShare);
  container.querySelector('[data-action="save"]')!.addEventListener('click', callbacks.onSave);
  container.querySelector('[data-action="export"]')!.addEventListener('click', callbacks.onExportGpx);

  container.querySelectorAll<HTMLButtonElement>('.detail-tab').forEach((button) => {
    button.addEventListener('click', () => {
      state.routeDetailTab = button.dataset.tab as 'climbs' | 'surface' | 'stops';
      renderRouteDetailFullscreen(container, data, callbacks);
    });
  });
  const climbButtons = container.querySelectorAll<HTMLButtonElement>('[data-climb-index]');
  climbButtons.forEach((button) => {
    const index = Number(button.dataset.climbIndex);
    button.addEventListener('click', () => {
      climbButtons.forEach((b, i) => b.classList.toggle('active', i === index));
      callbacks.onClimbClick(data.climbs[index], index);
    });
  });
  const pois = [...data.cafes, ...data.water].sort((a, b) => a.atKm - b.atKm);
  container.querySelectorAll<HTMLButtonElement>('[data-stop-index]').forEach((button) => {
    const stop = pois[Number(button.dataset.stopIndex)];
    if (stop) button.addEventListener('click', () => callbacks.onPoiClick(stop.lngLat));
  });

  return container.querySelector<HTMLCanvasElement>('.detail-chart')!;
}

/** Renders the desktop floating panel: title/actions, chart, a 4-stat row. No tabs. */
export function renderRouteDetailPanel(
  container: HTMLElement,
  data: RouteDetailData,
  callbacks: Pick<RouteDetailCallbacks, 'onSave' | 'onExportGpx'>,
): HTMLCanvasElement {
  const unpavedPct = unpavedFraction(data.surfaceTotals);
  container.innerHTML =
    `<div class="detail-panel-header">` +
    `<span class="detail-title">${escapeHtml(data.title)}</span>` +
    `<div class="detail-panel-actions">` +
    `<button type="button" class="pill-btn" data-action="save">${ICONS.bookmark}Save</button>` +
    `<button type="button" class="pill-btn primary" data-action="export">${ICONS.exportIco}Export GPX</button>` +
    `</div>` +
    `</div>` +
    `<div class="detail-chart-wrap"><canvas class="detail-chart"></canvas></div>` +
    statRow([
      { label: 'Distance', value: data.distanceKm.toFixed(1), unit: 'km' },
      { label: 'Climbing', value: String(Math.round(data.ascendM)), unit: 'm' },
      { label: 'Time', value: formatTime(data.timeHours), unit: '' },
      { label: 'Unpaved', value: unpavedPct === null ? '–' : String(Math.round(unpavedPct * 100)), unit: unpavedPct === null ? '' : '%' },
    ]);

  container.querySelector('[data-action="save"]')!.addEventListener('click', callbacks.onSave);
  container.querySelector('[data-action="export"]')!.addEventListener('click', callbacks.onExportGpx);

  return container.querySelector<HTMLCanvasElement>('.detail-chart')!;
}

export function clearRouteDetail(mobile: HTMLElement, panel: HTMLElement): void {
  mobile.innerHTML = '';
  panel.innerHTML = '';
}
