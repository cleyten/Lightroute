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
import { fetchRoundTrip } from './ors';

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
const roundtripKm = document.querySelector<HTMLInputElement>('#roundtrip-km')!;
const btnRoundtrip = document.querySelector<HTMLButtonElement>('#btn-roundtrip')!;
const chartCanvas = document.querySelector<HTMLCanvasElement>('#elevation-chart')!;
const surfaceEl = document.querySelector<HTMLElement>('#surface')!;

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
  map.on('mouseenter', 'route-line', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'route-line', () => {
    map.getCanvas().style.cursor = '';
  });
});

map.on('click', (event) => {
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
    routeNameInput.value.trim() || `Route ${new Date().toLocaleDateString('nl-NL')}`;
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
  setStatus(`Route "${name}" opgeslagen.`);
});

btnRoundtrip.addEventListener('click', async () => {
  if (state.waypoints.length === 0) {
    setStatus('Klik eerst één startpunt op de kaart.', true);
    return;
  }
  const km = Number(roundtripKm.value);
  if (!km || km < 5 || km > 100) {
    setStatus('Kies een rondrit-afstand tussen 5 en 100 km.', true);
    return;
  }

  // A round trip replaces any multi-point route; only the start point remains.
  state.waypoints = [state.waypoints[0]];
  rebuildMarkers();

  const requestId = ++state.requestId;
  setStatus('Rondrit genereren…');
  try {
    const route = await fetchRoundTrip(state.waypoints[0], km * 1000, settings.bike);
    if (requestId !== state.requestId) return;
    state.route = route;
    setRouteData(route.geojson);
    renderRouteDetails();
    setStatus('Niet tevreden? Klik nogmaals op Genereer voor een andere lus.');
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus(error instanceof Error ? error.message : 'Er ging iets mis.', true);
  }
  updateControls();
});

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

  if (state.waypoints.length < 2) {
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus('');
    updateControls();
    return;
  }

  setStatus('Route berekenen…');
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
    setStatus(error instanceof Error ? error.message : 'Er ging iets mis.', true);
  }
  updateControls();
}

function setRouteData(data: FeatureCollection): void {
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

/** Renders stats, elevation chart and surface bar for the current route (or clears them). */
function renderRouteDetails(): void {
  if (state.route) {
    statDistance.textContent = `${(state.route.distanceMeters / 1000).toFixed(1)} km`;
    statAscend.textContent = `${Math.round(state.route.ascendMeters)} m`;

    chartWrap.hidden = false;
    renderElevationChart(chartCanvas, state.route.coordinates, (index) => {
      const [lng, lat] = state.route!.coordinates[index];
      hoverMarker.setLngLat([lng, lat]);
      if (!hoverMarkerVisible) {
        hoverMarker.addTo(map);
        hoverMarkerVisible = true;
      }
    });

    const totals = surfaceBreakdown(state.route.messages);
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
    clearElevationChart();
    if (hoverMarkerVisible) {
      hoverMarker.remove();
      hoverMarkerVisible = false;
    }
  }
}

async function refreshSavedList(): Promise<void> {
  const routes = await listRoutes();
  savedList.innerHTML = '';
  for (const route of routes) {
    const item = document.createElement('li');

    const label = document.createElement('button');
    label.className = 'saved-name';
    label.textContent = `${route.name} · ${(route.distanceMeters / 1000).toFixed(1)} km`;
    label.title = 'Laad deze route';
    label.addEventListener('click', () => loadSaved(route));

    const remove = document.createElement('button');
    remove.className = 'saved-delete';
    remove.textContent = '✕';
    remove.title = 'Verwijder';
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
