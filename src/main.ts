import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchRoute, type LngLat, type RouteResult } from './routing';
import { downloadGpx } from './gpx';
import { haversineMeters } from './geo';
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
};

const statDistance = document.querySelector<HTMLElement>('#stat-distance')!;
const statAscend = document.querySelector<HTMLElement>('#stat-ascend')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
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
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [5.3, 51.9], // Netherlands
  zoom: 7,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

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
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#2424e8',
      'line-width': 4,
      'line-opacity': 0.85,
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
});

map.on('click', (event) => {
  // Clicks on a café marker open its popup instead of adding a waypoint.
  if (map.getLayer('cafe-dots')) {
    if (map.queryRenderedFeatures(event.point, { layers: ['cafe-dots'] }).length > 0) return;
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

btnUndo.addEventListener('click', () => {
  state.waypoints.pop();
  rebuildMarkers();
  void recalculateRoute();
});

btnClear.addEventListener('click', () => {
  state.waypoints = [];
  rebuildMarkers();
  void recalculateRoute();
});

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
  if (!minKm || !maxKm || minKm < 5 || maxKm > 100 || minKm >= maxKm) {
    setStatus('Enter a distance range like 40 – 55 km (5 to 100 km, min below max).', true);
    return;
  }

  // A round trip replaces any multi-point route; only the start point remains.
  state.waypoints = [state.waypoints[0]];
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
  setRouteData(option.route.geojson);
  renderRouteDetails();
  updateControls();
  [...loopOptionsEl.children].forEach((el, i) =>
    el.classList.toggle('active', i === index),
  );

  const coords = option.route.coordinates;
  const bounds = coords.reduce(
    (acc, c) => acc.extend([c[0], c[1]]),
    new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
  );
  map.fitBounds(bounds, { padding: 60 });
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
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(waypoint)
      .addTo(map);
    marker.on('dragend', () => {
      const markerIndex = state.markers.indexOf(marker);
      const position = marker.getLngLat();
      state.waypoints[markerIndex] = [position.lng, position.lat];
      void recalculateRoute();
    });
    return marker;
  });
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
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus('');
    updateControls();
    return;
  }

  setStatus('Calculating route…');
  try {
    const route = await fetchRoute(state.waypoints, currentProfile());
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
  btnUndo.disabled = state.waypoints.length === 0;
  btnClear.disabled = state.waypoints.length === 0;
  btnExport.disabled = !state.route;
  // Saving stores waypoints for re-routing, which a generated loop doesn't have.
  btnSave.disabled = !state.route || state.waypoints.length < 2;
}

syncProfileUi();
void refreshSavedList();
