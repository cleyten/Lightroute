import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchRoute, type LngLat, type RouteResult } from './routing';
import { downloadGpx } from './gpx';
import { haversineMeters, cumulativeDistances, elevationGain } from './geo';
import { renderElevationChart, clearElevationChart } from './chart';
import { surfaceBreakdown, renderSurfaceBar } from './surface';
import { saveRoute, listRoutes, deleteRoute, type SavedRoute } from './storage';
import { generateRoundTrips, rejectionText, type LoopOption } from './ors';
import { detectClimbs, type Climb } from './climbs';
import { compassLabel, type WindInfo } from './wind';
import { searchPlaces, type GeocodeResult } from './geocode';
import { fetchCafes, type Cafe } from './cafes';

type BikeType = 'race' | 'gravel' | 'mtb';

interface Settings {
  bike: BikeType;
  traffic: number; // 0 = fastest, 1 = low traffic, 2 = very low traffic (race only)
}

const SETTINGS_KEY = 'lightroute-settings';
const TRAFFIC_PROFILES = ['fastbike', 'fastbike-lowtraffic', 'fastbike-verylowtraffic'];

const settings: Settings = loadSettings();

// All application state lives in this one object.
const state = {
  waypoints: [] as LngLat[],
  markers: [] as maplibregl.Marker[],
  route: null as RouteResult | null,
  // Incremented per routing request so stale responses can be ignored.
  requestId: 0,
  // Round-trip suggestions currently on offer, and the selected one.
  loopOptions: [] as LoopOption[],
  selectedLoop: -1,
  climbs: [] as Climb[],
  selectedClimb: -1,
  cafes: [] as Cafe[],
  // Route returns to waypoint 1 (a closed loop): set by generating a round
  // trip or by clicking near point 1.
  closed: false,
};

const statDistance = document.querySelector<HTMLElement>('#stat-distance')!;
const statAscend = document.querySelector<HTMLElement>('#stat-ascend')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnReverse = document.querySelector<HTMLButtonElement>('#btn-reverse')!;
const btnExport = document.querySelector<HTMLButtonElement>('#btn-export')!;
const btnSave = document.querySelector<HTMLButtonElement>('#btn-save')!;
const routeNameInput = document.querySelector<HTMLInputElement>('#route-name')!;
const savedList = document.querySelector<HTMLUListElement>('#saved-list')!;
const bikeButtons = [...document.querySelectorAll<HTMLButtonElement>('#bike-type button')];
const trafficLabel = document.querySelector<HTMLElement>('#traffic-label')!;
const trafficSelect = document.querySelector<HTMLSelectElement>('#traffic-select')!;
const chartWrap = document.querySelector<HTMLElement>('#chart-wrap')!;
const roundtripMin = document.querySelector<HTMLInputElement>('#roundtrip-min')!;
const roundtripMax = document.querySelector<HTMLInputElement>('#roundtrip-max')!;
const rangeValue = document.querySelector<HTMLElement>('#range-value')!;
const rangeTrack = document.querySelector<HTMLElement>('#range-track')!;
const btnRoundtrip = document.querySelector<HTMLButtonElement>('#btn-roundtrip')!;
const roundtripHilly = document.querySelector<HTMLInputElement>('#roundtrip-hilly')!;
const chartCanvas = document.querySelector<HTMLCanvasElement>('#elevation-chart')!;
const surfaceEl = document.querySelector<HTMLElement>('#surface')!;
const loopOptionsEl = document.querySelector<HTMLElement>('#loop-options')!;
const windChipEl = document.querySelector<HTMLElement>('#wind-chip')!;
const climbsEl = document.querySelector<HTMLElement>('#climbs')!;
const climbsList = document.querySelector<HTMLUListElement>('#climbs-list')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const searchResults = document.querySelector<HTMLUListElement>('#search-results')!;
const btnLocate = document.querySelector<HTMLButtonElement>('#btn-locate')!;
const cafesEl = document.querySelector<HTMLElement>('#cafes')!;
const cafeKmInput = document.querySelector<HTMLInputElement>('#cafe-km')!;
const btnCafes = document.querySelector<HTMLButtonElement>('#btn-cafes')!;
const cafesList = document.querySelector<HTMLUListElement>('#cafes-list')!;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [5.3, 51.9], // Netherlands
  zoom: 7,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Basemap switcher. "clean" is the vector positron base; terrain and cycling
// are raster layers drawn on top of it but below the route overlays.
const RASTER_BASEMAPS: Record<
  string,
  { tiles: string[]; attribution: string; maxzoom: number }
> = {
  terrain: {
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    attribution:
      'Map data: © OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    maxzoom: 17,
  },
  cycling: {
    tiles: [
      'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    ],
    attribution: 'CyclOSM | Map data: © OpenStreetMap contributors',
    maxzoom: 20,
  },
};
let currentBasemap = 'clean';

function setBasemap(style: string): void {
  if (style === currentBasemap) return;
  if (map.getLayer('basemap-raster')) map.removeLayer('basemap-raster');
  if (map.getSource('basemap-raster')) map.removeSource('basemap-raster');
  const cfg = RASTER_BASEMAPS[style];
  if (cfg) {
    map.addSource('basemap-raster', {
      type: 'raster',
      tiles: cfg.tiles,
      tileSize: 256,
      maxzoom: cfg.maxzoom,
      attribution: cfg.attribution,
    });
    // Keep the raster below the route overlays so the route stays on top.
    const beforeId = map.getLayer('route-casing') ? 'route-casing' : undefined;
    map.addLayer({ id: 'basemap-raster', type: 'raster', source: 'basemap-raster' }, beforeId);
  }
  currentBasemap = style;
}

// Dot shown on the map while hovering the elevation chart.
const hoverDotEl = document.createElement('div');
hoverDotEl.className = 'hover-dot';
const hoverMarker = new maplibregl.Marker({ element: hoverDotEl });
let hoverMarkerVisible = false;

map.on('load', () => {
  // Empty GeoJSON source; its data is replaced whenever a route is calculated.
  map.addSource('route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // White casing under the route so it reads on any basemap.
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 7,
      'line-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#2424e8',
      'line-width': 4,
      'line-opacity': 0.95,
    },
  });
  // Café markers along the current route.
  map.addSource('cafes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'cafe-dots',
    type: 'circle',
    source: 'cafes',
    paint: {
      'circle-radius': 6,
      'circle-color': '#8a5a2b',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  map.on('click', 'cafe-dots', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties as { name: string; detail: string };
    new maplibregl.Popup({ offset: 10 })
      .setLngLat(event.lngLat)
      .setHTML(
        `<strong>${escapeHtml(props.name)}</strong><br>${escapeHtml(props.detail)}`,
      )
      .addTo(map);
  });
  map.on('mouseenter', 'cafe-dots', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'cafe-dots', () => {
    map.getCanvas().style.cursor = '';
  });

  // Highlight layer for a selected climb, drawn on top of the route.
  map.addSource('climb-highlight', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'climb-line',
    type: 'line',
    source: 'climb-highlight',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#e8571a',
      'line-width': 5,
      'line-opacity': 0.95,
    },
  });
  map.on('mouseenter', 'route-line', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'route-line', () => {
    map.getCanvas().style.cursor = '';
  });

  // Wire the basemap switcher now that the overlay layers exist.
  const mapstyleEl = document.querySelector<HTMLDivElement>('#mapstyle');
  if (mapstyleEl) {
    mapstyleEl.hidden = false;
    mapstyleEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        setBasemap(btn.dataset.style ?? 'clean');
        mapstyleEl
          .querySelectorAll('button')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }
});

map.on('click', (event) => {
  // Clicks on a café marker open its popup instead of adding a waypoint.
  if (map.getLayer('cafe-dots')) {
    if (map.queryRenderedFeatures(event.point, { layers: ['cafe-dots'] }).length > 0) return;
  }
  // Clicking near point 1 closes an open route into a loop.
  if (!state.closed && state.waypoints.length >= 3 && nearFirstWaypoint(event.point)) {
    void closeLoop();
    return;
  }
  // A click on the route line inserts a via-point instead of appending.
  if (state.waypoints.length >= 2 && map.getLayer('route-line')) {
    const pad = 6;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [event.point.x - pad, event.point.y - pad],
      [event.point.x + pad, event.point.y + pad],
    ];
    if (map.queryRenderedFeatures(box, { layers: ['route-line'] }).length > 0) {
      insertViaPoint([event.lngLat.lng, event.lngLat.lat]);
      return;
    }
  }
  state.waypoints.push([event.lngLat.lng, event.lngLat.lat]);
  rebuildMarkers();
  void recalculateRoute();
});

/** True when a screen point is within grabbing distance of waypoint 1. */
function nearFirstWaypoint(point: maplibregl.Point): boolean {
  if (state.waypoints.length === 0) return false;
  const first = map.project(state.waypoints[0]);
  return Math.hypot(point.x - first.x, point.y - first.y) <= 16;
}

/** Closes the current open route so it returns to point 1. */
async function closeLoop(): Promise<void> {
  state.closed = true;
  await recalculateRoute();
  if (state.route) {
    setStatus('Loop closed. Drag points to adjust, or Reverse direction for the way back.');
  }
}

btnUndo.addEventListener('click', () => {
  // Undo reopens a closed loop first, then removes points one by one.
  if (state.closed) {
    state.closed = false;
  } else {
    state.waypoints.pop();
  }
  rebuildMarkers();
  void recalculateRoute();
});

btnClear.addEventListener('click', () => {
  state.waypoints = [];
  state.closed = false;
  rebuildMarkers();
  void recalculateRoute();
});

btnReverse.addEventListener('click', () => {
  if (!state.route) return;
  const reversed = [...state.route.coordinates].reverse();
  state.route = {
    ...state.route,
    coordinates: reversed,
    ascendMeters: elevationGain(reversed),
    geojson: lineFeatureCollection(reversed),
  };
  // Keep waypoints in step with the new direction so later edits reroute
  // correctly. For a closed loop, point 1 stays the start; only the order
  // of the points in between flips.
  if (state.closed && state.waypoints.length > 2) {
    state.waypoints = [state.waypoints[0], ...state.waypoints.slice(1).reverse()];
  } else {
    state.waypoints.reverse();
  }
  rebuildMarkers();
  setRouteData(state.route.geojson);
  renderRouteDetails();
  setStatus('Direction reversed. Export GPX now follows the route the other way round.');
});

/** Wraps a coordinate list in the FeatureCollection the map source expects. */
function lineFeatureCollection(coordinates: [number, number, number][]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } },
    ],
  };
}

btnExport.addEventListener('click', () => {
  if (!state.route) return;
  const name =
    routeNameInput.value.trim() || `Lightroute ${new Date().toISOString().slice(0, 10)}`;
  downloadGpx(state.route.coordinates, name);
});

btnSave.addEventListener('click', async () => {
  if (!state.route || state.waypoints.length < 2) return;
  const name =
    routeNameInput.value.trim() || `Route ${new Date().toISOString().slice(0, 10)}`;
  await saveRoute({
    name,
    waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
    bike: settings.bike,
    traffic: settings.traffic,
    distanceMeters: state.route.distanceMeters,
    createdAt: new Date().toISOString(),
    closed: state.closed,
  });
  routeNameInput.value = '';
  await refreshSavedList();
  setStatus(`Route "${name}" saved.`);
});

btnRoundtrip.addEventListener('click', async () => {
  if (state.waypoints.length === 0) {
    setStatus('First click a start point on the map.', true);
    return;
  }
  const minKm = Number(roundtripMin.value);
  const maxKm = Number(roundtripMax.value);
  if (!minKm || !maxKm || minKm >= maxKm) {
    setStatus('Drag the two handles to set a distance range first.', true);
    return;
  }

  // A round trip replaces any multi-point route; only the start point remains.
  state.waypoints = [state.waypoints[0]];
  state.closed = false;
  rebuildMarkers();

  const requestId = ++state.requestId;
  setStatus('Generating and checking loops… (this can take ~15 s)');
  btnRoundtrip.disabled = true;
  try {
    const result = await generateRoundTrips(
      state.waypoints[0],
      minKm * 1000,
      maxKm * 1000,
      settings.bike,
      roundtripHilly.checked,
    );
    if (requestId !== state.requestId) return;

    renderWindChip(result.wind);
    if (result.options.length > 0) {
      state.loopOptions = result.options;
      renderLoopOptions();
      selectLoop(0);
      setStatus(
        result.options.length > 1
          ? 'Pick a loop below, or Generate again for new ones.'
          : 'One good loop found. Generate again for new ones.',
      );
    } else {
      state.loopOptions = [];
      state.route = null;
      setRouteData({ type: 'FeatureCollection', features: [] });
      renderRouteDetails();
      renderNoLoopFound(result.failReason, result.fallback);
    }
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.loopOptions = [];
    renderLoopOptions();
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', true);
  } finally {
    if (requestId === state.requestId) btnRoundtrip.disabled = false;
  }
  updateControls();
});

/** Renders the quality-passed loops as selectable options. */
function renderLoopOptions(): void {
  loopOptionsEl.innerHTML = '';
  loopOptionsEl.hidden = state.loopOptions.length === 0;
  state.loopOptions.forEach((option, index) => {
    const button = document.createElement('button');
    button.className = 'loop-option';
    button.classList.toggle('active', index === state.selectedLoop);

    const parts = [
      `${(option.route.distanceMeters / 1000).toFixed(1)} km`,
      `${Math.round(option.route.ascendMeters)} m up`,
    ];
    if (option.unpaved !== null) parts.push(`${Math.round(option.unpaved * 100)}% unpaved`);
    if (option.network !== null && option.network > 0.15) {
      parts.push(`${Math.round(option.network * 100)}% on cycle routes`);
    }
    const title = document.createElement('span');
    title.className = 'loop-title';
    title.textContent = `Loop ${index + 1}`;
    const detail = document.createElement('span');
    detail.className = 'loop-detail';
    detail.textContent = parts.join(' · ');
    button.append(title, detail);
    if (option.windNote) {
      const wind = document.createElement('span');
      wind.className = 'loop-wind';
      wind.textContent = option.windNote;
      button.append(wind);
    }
    button.addEventListener('click', () => selectLoop(index));
    loopOptionsEl.append(button);
  });
}

function selectLoop(index: number): void {
  const option = state.loopOptions[index];
  if (!option) return;
  state.selectedLoop = index;
  state.route = option.route;

  // Turn the generated loop into an editable route: drop a handful of
  // draggable waypoints along it and mark it closed. The ORS geometry stays
  // on screen until the user actually drags a point, which reroutes through
  // these waypoints via BRouter.
  const coords = option.route.coordinates;
  state.waypoints = extractLoopWaypoints(coords);
  state.closed = true;
  rebuildMarkers();

  setRouteData(option.route.geojson);
  renderRouteDetails();
  updateControls();
  [...loopOptionsEl.children].forEach((el, i) =>
    el.classList.toggle('active', i === index),
  );

  const bounds = coords.reduce(
    (acc, c) => acc.extend([c[0], c[1]]),
    new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
  );
  map.fitBounds(bounds, { padding: 60 });
}

/** Minimum spacing between editable waypoints (avoids clustering). */
const WP_MIN_GAP_M = 1500;
/** Maximum spacing: guarantees at least one waypoint per 5 km. */
const WP_MAX_GAP_M = 5000;
/** A vertex counts as a turn above this bearing change (degrees). */
const WP_TURN_DEG = 30;

/**
 * Picks editable waypoints along a generated loop. Within each 1.5-5 km
 * window it places the waypoint on the sharpest turn (so dragging reshapes
 * real corners and junctions); if the stretch is straight it falls back to
 * the 5 km mark. The first waypoint is always the start.
 */
function extractLoopWaypoints(coords: [number, number, number][]): LngLat[] {
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const waypoints: LngLat[] = [[coords[0][0], coords[0][1]]];
  if (total <= WP_MAX_GAP_M) return waypoints;

  const turns = turnMagnitudes(coords, cum);
  let lastDist = 0;
  // Keep placing until the closing leg (last point back to start) is <= 5 km.
  while (total - lastDist > WP_MAX_GAP_M) {
    const windowStart = lastDist + WP_MIN_GAP_M;
    const windowEnd = Math.min(lastDist + WP_MAX_GAP_M, total - WP_MIN_GAP_M);

    let placeIdx = -1;
    let bestTurn = WP_TURN_DEG;
    for (let i = 0; i < coords.length; i++) {
      if (cum[i] < windowStart) continue;
      if (cum[i] > windowEnd) break;
      if (turns[i] > bestTurn) {
        bestTurn = turns[i];
        placeIdx = i;
      }
    }
    if (placeIdx < 0) placeIdx = indexAtDistance(cum, windowEnd); // straight: 5 km mark

    waypoints.push([coords[placeIdx][0], coords[placeIdx][1]]);
    lastDist = cum[placeIdx];
  }
  return waypoints;
}

/** Bearing change (0-180 deg) at each vertex, over an ~80 m window each side. */
function turnMagnitudes(coords: [number, number, number][], cum: number[]): number[] {
  const WINDOW_M = 80;
  const out = new Array(coords.length).fill(0);
  for (let i = 1; i < coords.length - 1; i++) {
    let back = i;
    while (back > 0 && cum[i] - cum[back] < WINDOW_M) back--;
    let fwd = i;
    while (fwd < coords.length - 1 && cum[fwd] - cum[i] < WINDOW_M) fwd++;
    if (back === i || fwd === i) continue;
    out[i] = bearingChange(bearingDeg(coords[back], coords[i]), bearingDeg(coords[i], coords[fwd]));
  }
  return out;
}

function bearingDeg(a: [number, number, number], b: [number, number, number]): number {
  const x = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  const y = b[1] - a[1];
  return (Math.atan2(x, y) * 180) / Math.PI;
}

function bearingChange(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function indexAtDistance(cum: number[], distance: number): number {
  let i = 0;
  while (i < cum.length - 1 && cum[i] < distance) i++;
  return i;
}

/** Honest message when no loop passed the quality gates, with an escape hatch. */
function renderNoLoopFound(reason: string | null, fallback: LoopOption | null): void {
  setStatus(`No good loop found: ${reason ?? 'nothing suitable here'}. Try another distance or start point.`, true);
  loopOptionsEl.innerHTML = '';
  loopOptionsEl.hidden = fallback === null;
  if (!fallback) return;

  const button = document.createElement('button');
  button.className = 'loop-option fallback';
  const title = document.createElement('span');
  title.className = 'loop-title';
  title.textContent = 'Show best match anyway';
  const detail = document.createElement('span');
  detail.className = 'loop-detail';
  detail.textContent =
    `${(fallback.route.distanceMeters / 1000).toFixed(1)} km · but ${rejectionText(fallback)}`;
  button.append(title, detail);
  button.addEventListener('click', () => {
    state.loopOptions = [fallback];
    renderLoopOptions();
    selectLoop(0);
    setStatus('This loop did not pass the quality check; treat it as a rough suggestion.');
  });
  loopOptionsEl.append(button);
}

function renderWindChip(wind: WindInfo | null): void {
  windChipEl.hidden = wind === null;
  if (!wind) return;
  windChipEl.innerHTML = '';
  const arrow = document.createElement('span');
  arrow.className = 'wind-arrow';
  arrow.textContent = '➤';
  // The arrow glyph points east; rotate it to where the wind blows TO.
  arrow.style.transform = `rotate(${Math.round(wind.fromDeg + 90)}deg)`;
  const label = document.createElement('span');
  label.textContent = ` Wind now: ${Math.round(wind.speedKmh)} km/h from ${compassLabel(wind.fromDeg)}`;
  windChipEl.append(arrow, label);
}

// --- Address search & GPS locate -------------------------------------------

/** Adds a waypoint as if the user clicked the map there; flies there if it is the first. */
function addWaypoint(lngLat: LngLat, label?: string): void {
  const isFirst = state.waypoints.length === 0;
  state.waypoints.push(lngLat);
  rebuildMarkers();
  void recalculateRoute();
  if (isFirst) {
    map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 12) });
    setStatus(label ? `Start set at ${label}.` : 'Start point set.');
  } else if (label) {
    setStatus(`Added ${label} as point ${state.waypoints.length}.`);
  }
}

let searchTimer: number | undefined;
let searchAbort: AbortController | null = null;

searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 3) {
    renderSearchResults([]);
    return;
  }
  searchTimer = window.setTimeout(async () => {
    searchAbort?.abort();
    searchAbort = new AbortController();
    try {
      const center = map.getCenter();
      const results = await searchPlaces(query, [center.lng, center.lat], searchAbort.signal);
      renderSearchResults(results);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        renderSearchResults([]);
        setStatus('Address search failed; try again.', true);
      }
    }
  }, 350);
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') renderSearchResults([]);
});

function renderSearchResults(results: GeocodeResult[]): void {
  searchResults.innerHTML = '';
  searchResults.hidden = results.length === 0;
  for (const result of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'search-result';
    const label = document.createElement('span');
    label.className = 'search-label';
    label.textContent = result.label;
    const detail = document.createElement('span');
    detail.className = 'search-detail';
    detail.textContent = result.detail;
    button.append(label, detail);
    button.addEventListener('click', () => {
      searchInput.value = '';
      renderSearchResults([]);
      addWaypoint([...result.lngLat] as LngLat, result.label);
    });
    item.append(button);
    searchResults.append(item);
  }
}

btnLocate.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    setStatus('This browser does not support GPS location.', true);
    return;
  }
  setStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      addWaypoint([position.coords.longitude, position.coords.latitude], 'your location');
    },
    () => setStatus('Could not get your location. Check the location permission.', true),
    { timeout: 10000, maximumAge: 60000 },
  );
});

// --- Round-trip distance range slider ----------------------------------------

/** Keeps the two thumbs apart and paints the label and the selected track segment. */
function syncRangeSlider(moved: 'min' | 'max'): void {
  const step = Number(roundtripMin.step) || 5;
  let min = Number(roundtripMin.value);
  let max = Number(roundtripMax.value);
  if (min > max - step) {
    if (moved === 'min') {
      min = max - step;
      roundtripMin.value = String(min);
    } else {
      max = min + step;
      roundtripMax.value = String(max);
    }
  }
  rangeValue.textContent = `${min} – ${max}`;
  const lo = Number(roundtripMin.min);
  const hi = Number(roundtripMin.max);
  const fromPct = ((min - lo) / (hi - lo)) * 100;
  const toPct = ((max - lo) / (hi - lo)) * 100;
  rangeTrack.style.background =
    `linear-gradient(to right, var(--color-border) ${fromPct}%, ` +
    `var(--color-accent) ${fromPct}%, var(--color-accent) ${toPct}%, ` +
    `var(--color-border) ${toPct}%)`;
}

roundtripMin.addEventListener('input', () => syncRangeSlider('min'));
roundtripMax.addEventListener('input', () => syncRangeSlider('max'));
syncRangeSlider('min');

// --- Cafés along the route ---------------------------------------------------

btnCafes.addEventListener('click', async () => {
  if (!state.route) return;
  btnCafes.disabled = true;
  setStatus('Searching cafés along the route…');
  try {
    state.cafes = await fetchCafes(state.route.coordinates);
    renderCafes();
    setStatus(state.cafes.length === 0 ? 'No cafés found along this route.' : '');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Café search failed.', true);
  } finally {
    btnCafes.disabled = false;
  }
});

cafeKmInput.addEventListener('input', () => {
  if (state.cafes.length > 0) renderCafes();
});

/** Renders the café list (optionally filtered around a km mark) and the map dots. */
function renderCafes(): void {
  const aroundKm = Number(cafeKmInput.value);
  const filtered =
    cafeKmInput.value !== '' && !Number.isNaN(aroundKm)
      ? state.cafes.filter((cafe) => Math.abs(cafe.atKm - aroundKm) <= 5)
      : state.cafes;

  cafesList.innerHTML = '';
  if (state.cafes.length > 0 && filtered.length === 0) {
    const note = document.createElement('li');
    note.className = 'cafe-empty';
    note.textContent = `No cafés within 5 km of km ${aroundKm}.`;
    cafesList.append(note);
  }
  for (const cafe of filtered.slice(0, 25)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'cafe-item';
    button.innerHTML =
      `<span class="cafe-where">km ${cafe.atKm.toFixed(1)}</span>` +
      `<span class="cafe-name">${escapeHtml(cafe.name)}</span>` +
      `<span class="cafe-detour">${Math.round(cafe.offRouteM)} m</span>`;
    if (cafe.openingHours) button.title = `Opening hours: ${cafe.openingHours}`;
    button.addEventListener('click', () => {
      map.flyTo({ center: cafe.lngLat, zoom: 15 });
    });
    item.append(button);
    cafesList.append(item);
  }
  setCafeData(filtered);
}

function setCafeData(cafes: Cafe[]): void {
  const source = map.getSource('cafes') as maplibregl.GeoJSONSource | undefined;
  source?.setData({
    type: 'FeatureCollection',
    features: cafes.map((cafe) => ({
      type: 'Feature',
      properties: {
        name: cafe.name,
        detail:
          `at km ${cafe.atKm.toFixed(1)}, ${Math.round(cafe.offRouteM)} m off route` +
          (cafe.openingHours ? `<br>${cafe.openingHours}` : ''),
      },
      geometry: { type: 'Point', coordinates: cafe.lngLat },
    })),
  });
}

function clearCafes(): void {
  state.cafes = [];
  cafesList.innerHTML = '';
  cafeKmInput.value = '';
  setCafeData([]);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

bikeButtons.forEach((button) =>
  button.addEventListener('click', () => {
    settings.bike = button.dataset.bike as BikeType;
    persistSettings();
    syncProfileUi();
    void recalculateRoute();
  }),
);

trafficSelect.addEventListener('change', () => {
  settings.traffic = Number(trafficSelect.value);
  persistSettings();
  void recalculateRoute();
});

chartCanvas.addEventListener('mouseleave', () => {
  if (hoverMarkerVisible) {
    hoverMarker.remove();
    hoverMarkerVisible = false;
  }
});

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (['race', 'gravel', 'mtb'].includes(parsed.bike)) {
        return {
          bike: parsed.bike,
          traffic: [0, 1, 2].includes(parsed.traffic) ? parsed.traffic : 0,
        };
      }
    }
  } catch {
    // Corrupt settings fall through to the defaults.
  }
  return { bike: 'race', traffic: 0 };
}

function persistSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function currentProfile(): string {
  if (settings.bike === 'gravel') return 'gravel';
  if (settings.bike === 'mtb') return 'mtb';
  return TRAFFIC_PROFILES[settings.traffic];
}

function syncProfileUi(): void {
  bikeButtons.forEach((button) =>
    button.classList.toggle('active', button.dataset.bike === settings.bike),
  );
  trafficLabel.hidden = settings.bike !== 'race';
  trafficSelect.value = String(settings.traffic);
}

/** Recreates all markers from state.waypoints, keeping numbering correct. */
function rebuildMarkers(): void {
  state.markers.forEach((marker) => marker.remove());
  state.markers = state.waypoints.map((waypoint, index) => {
    const el = document.createElement('div');
    el.className = 'waypoint-marker';
    el.textContent = String(index + 1);
    el.title =
      index === 0
        ? 'Point 1 (start). Drag to move; click to close the loop.'
        : 'Drag to move; click to remove this point.';
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(waypoint)
      .addTo(map);

    // Distinguish a click (remove/close) from a drag (move): a drag fires
    // dragstart, which suppresses the click that the browser fires on release.
    let dragged = false;
    marker.on('dragstart', () => {
      dragged = true;
    });
    marker.on('dragend', () => {
      const markerIndex = state.markers.indexOf(marker);
      const position = marker.getLngLat();
      state.waypoints[markerIndex] = [position.lng, position.lat];
      void recalculateRoute();
    });
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      const markerIndex = state.markers.indexOf(marker);
      if (markerIndex === 0) {
        // Point 1 is the start/anchor: a click closes an open loop but never
        // deletes the point (use Clear to start over).
        if (!state.closed && state.waypoints.length >= 3) void closeLoop();
        return;
      }
      removeWaypoint(markerIndex);
    });
    return marker;
  });
}

/** Removes one waypoint by index, keeping a routable minimum. */
function removeWaypoint(index: number): void {
  if (index < 0 || index >= state.waypoints.length) return;
  const floor = state.closed ? 3 : 2;
  if (state.waypoints.length <= floor) {
    setStatus(
      state.closed
        ? 'A loop needs at least 3 points. Use Clear to start over.'
        : 'Use Undo or Clear to remove the last points.',
      true,
    );
    return;
  }
  state.waypoints.splice(index, 1);
  rebuildMarkers();
  void recalculateRoute();
}

/** Inserts a via-point into the leg it deviates least from (straight-line heuristic). */
function insertViaPoint(point: LngLat): void {
  let bestIndex = 1;
  let bestDetour = Infinity;
  for (let i = 0; i < state.waypoints.length - 1; i++) {
    const detour =
      haversineMeters(state.waypoints[i], point) +
      haversineMeters(point, state.waypoints[i + 1]) -
      haversineMeters(state.waypoints[i], state.waypoints[i + 1]);
    if (detour < bestDetour) {
      bestDetour = detour;
      bestIndex = i + 1;
    }
  }
  state.waypoints.splice(bestIndex, 0, point);
  rebuildMarkers();
  void recalculateRoute();
}

async function recalculateRoute(): Promise<void> {
  const requestId = ++state.requestId;

  // Manual routing replaces any round-trip suggestions.
  if (state.loopOptions.length > 0) {
    state.loopOptions = [];
    state.selectedLoop = -1;
    renderLoopOptions();
  }

  if (state.waypoints.length < 2) {
    state.closed = false;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus('');
    updateControls();
    return;
  }

  // A closed loop routes back to point 1 by repeating it as the final target.
  const routingWaypoints = state.closed
    ? [...state.waypoints, state.waypoints[0]]
    : state.waypoints;

  setStatus('Calculating route…');
  try {
    const route = await fetchRoute(routingWaypoints, currentProfile());
    if (requestId !== state.requestId) return; // a newer request superseded this one
    state.route = route;
    setRouteData(route.geojson);
    renderRouteDetails();
    setStatus('');
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', true);
  }
  updateControls();
}

function setRouteData(data: FeatureCollection): void {
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

/** Renders stats, elevation chart, surface bar and climbs for the current route (or clears them). */
function renderRouteDetails(): void {
  // Any route change invalidates café results found for the previous route.
  clearCafes();
  cafesEl.hidden = !state.route;

  if (state.route) {
    statDistance.textContent = `${(state.route.distanceMeters / 1000).toFixed(1)} km`;
    statAscend.textContent = `${Math.round(state.route.ascendMeters)} m`;

    state.climbs = detectClimbs(state.route.coordinates);
    state.selectedClimb = -1;
    setClimbHighlight(null);
    renderClimbsList();

    chartWrap.hidden = false;
    renderElevationChart(
      chartCanvas,
      state.route.coordinates,
      (index) => {
        const [lng, lat] = state.route!.coordinates[index];
        hoverMarker.setLngLat([lng, lat]);
        if (!hoverMarkerVisible) {
          hoverMarker.addTo(map);
          hoverMarkerVisible = true;
        }
      },
      state.climbs,
    );

    const totals = state.route.surface ?? surfaceBreakdown(state.route.messages);
    if (totals) {
      surfaceEl.hidden = false;
      renderSurfaceBar(surfaceEl, totals);
    } else {
      surfaceEl.hidden = true;
    }
  } else {
    statDistance.textContent = '–';
    statAscend.textContent = '–';
    chartWrap.hidden = true;
    surfaceEl.hidden = true;
    climbsEl.hidden = true;
    state.climbs = [];
    state.selectedClimb = -1;
    setClimbHighlight(null);
    clearElevationChart();
    if (hoverMarkerVisible) {
      hoverMarker.remove();
      hoverMarkerVisible = false;
    }
  }
}

/** Lists detected climbs; clicking one highlights it on the map and zooms to it. */
function renderClimbsList(): void {
  climbsEl.hidden = state.climbs.length === 0;
  climbsList.innerHTML = '';
  state.climbs.forEach((climb, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'climb-item';
    button.innerHTML =
      `<span class="climb-where">km ${climb.startKm.toFixed(1)}</span>` +
      `<span>${(climb.lengthM / 1000).toFixed(1)} km at ${climb.avgPct.toFixed(1)}%</span>` +
      `<span class="climb-gain">+${Math.round(climb.gainM)} m</span>`;
    button.title = `Steepest 100 m: ${climb.maxPct.toFixed(0)}%`;
    button.addEventListener('click', () => {
      if (state.selectedClimb === index) {
        state.selectedClimb = -1;
        setClimbHighlight(null);
      } else {
        state.selectedClimb = index;
        setClimbHighlight(climb);
        const coords = state.route!.coordinates.slice(climb.startIndex, climb.endIndex + 1);
        const bounds = coords.reduce(
          (acc, c) => acc.extend([c[0], c[1]]),
          new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
        );
        map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
      }
      [...climbsList.querySelectorAll('.climb-item')].forEach((el, i) =>
        el.classList.toggle('active', i === state.selectedClimb),
      );
    });
    item.append(button);
    climbsList.append(item);
  });
}

function setClimbHighlight(climb: Climb | null): void {
  const source = map.getSource('climb-highlight') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  if (!climb || !state.route) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: state.route.coordinates.slice(climb.startIndex, climb.endIndex + 1),
        },
      },
    ],
  });
}

async function refreshSavedList(): Promise<void> {
  const routes = await listRoutes();
  savedList.innerHTML = '';
  for (const route of routes) {
    const item = document.createElement('li');

    const label = document.createElement('button');
    label.className = 'saved-name';
    label.textContent = `${route.name} · ${(route.distanceMeters / 1000).toFixed(1)} km`;
    label.title = 'Load this route';
    label.addEventListener('click', () => loadSaved(route));

    const remove = document.createElement('button');
    remove.className = 'saved-delete';
    remove.textContent = '✕';
    remove.title = 'Delete';
    remove.addEventListener('click', async () => {
      await deleteRoute(route.id!);
      await refreshSavedList();
    });

    item.append(label, remove);
    savedList.append(item);
  }
}

function loadSaved(route: SavedRoute): void {
  state.waypoints = route.waypoints.map((wp) => [...wp] as LngLat);
  state.closed = route.closed ?? false;
  settings.bike = (['race', 'gravel', 'mtb'].includes(route.bike) ? route.bike : 'race') as BikeType;
  settings.traffic = [0, 1, 2].includes(route.traffic) ? route.traffic : 0;
  persistSettings();
  syncProfileUi();
  rebuildMarkers();
  void recalculateRoute();

  const bounds = state.waypoints.reduce(
    (acc, wp) => acc.extend(wp),
    new maplibregl.LngLatBounds(state.waypoints[0], state.waypoints[0]),
  );
  map.fitBounds(bounds, { padding: 60 });
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateControls(): void {
  btnUndo.disabled = state.waypoints.length === 0 && !state.closed;
  btnClear.disabled = state.waypoints.length === 0;
  btnReverse.disabled = !state.route;
  btnExport.disabled = !state.route;
  btnSave.disabled = !state.route || state.waypoints.length < 2;
}

syncProfileUi();
void refreshSavedList();

// --- Mobile bottom sheet ---
// On phones the panel is a draggable sheet over a full-screen map. Dragging
// the handle snaps it between peek / half / full; tapping the handle cycles up.
(() => {
  const sheet = document.querySelector<HTMLElement>('#sidebar');
  const handle = document.querySelector<HTMLElement>('#sheet-handle');
  if (!sheet || !handle) return;
  const sheetEl = sheet;
  const handleEl = handle;
  const fab = document.querySelector<HTMLElement>('#gps-fab');
  const locateEl = document.querySelector<HTMLButtonElement>('#btn-locate');
  const distEl = document.querySelector<HTMLElement>('#stat-distance');

  const isMobile = () => window.matchMedia('(max-width: 700px)').matches;
  let snap = 0; // 0 = peek, 1 = half, 2 = full

  // Offsets in px to translate the sheet down by, per snap level.
  function offsets(): number[] {
    const h = sheetEl.offsetHeight;
    const peekVisible = 250;
    return [Math.max(0, h - peekVisible), Math.round(h * 0.45), 0];
  }

  function currentY(): number {
    const m = /translateY\(([-\d.]+)px\)/.exec(sheetEl.style.transform);
    return m ? parseFloat(m[1]) : offsets()[snap];
  }

  function apply(index: number, animate = true): void {
    snap = Math.max(0, Math.min(2, index));
    sheetEl.style.transition = animate ? '' : 'none';
    sheetEl.style.transform = `translateY(${offsets()[snap]}px)`;
    if (fab) {
      fab.style.opacity = snap === 0 ? '1' : '0';
      fab.style.pointerEvents = snap === 0 ? 'auto' : 'none';
    }
  }

  // Clear inline styles on desktop so the sheet transform never leaks there.
  function reset(): void {
    if (isMobile()) {
      apply(snap, false);
    } else {
      sheetEl.style.transform = '';
      sheetEl.style.transition = '';
      if (fab) {
        fab.style.opacity = '';
        fab.style.pointerEvents = '';
      }
    }
  }

  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  handleEl.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    dragging = true;
    startY = e.clientY;
    startOffset = currentY();
    sheetEl.style.transition = 'none';
    handleEl.setPointerCapture(e.pointerId);
  });
  handleEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = sheetEl.offsetHeight;
    const y = Math.min(Math.max(0, startOffset + (e.clientY - startY)), h - 80);
    sheetEl.style.transform = `translateY(${y}px)`;
  });
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = '';
    const y = currentY();
    // A tap (barely moved) cycles peek -> half -> full -> peek.
    if (Math.abs(y - startOffset) < 6) {
      apply(snap >= 2 ? 0 : snap + 1);
      return;
    }
    const offs = offsets();
    let best = 0;
    let bestDist = Infinity;
    offs.forEach((o, i) => {
      const d = Math.abs(o - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    apply(best);
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);

  // Raise to half the first time a route appears so the stats come into view.
  if (distEl) {
    const observer = new MutationObserver(() => {
      const text = distEl.textContent ?? '';
      if (isMobile() && snap === 0 && text && text !== '–') apply(1);
    });
    observer.observe(distEl, { childList: true, characterData: true, subtree: true });
  }

  if (fab && locateEl) {
    fab.addEventListener('click', () => locateEl.click());
  }

  window.addEventListener('resize', reset);
  reset();
})();

// Dev-only handle for verification in the browser console; stripped from
// the production build by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV) {
  (window as unknown as { __lr: unknown }).__lr = { map, state };
}
